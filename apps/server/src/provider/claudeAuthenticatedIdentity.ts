import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Hex from "effect/encoding/Hex";
import * as NodeModule from "node:module";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { ClaudeCapabilitiesProbe } from "./ClaudeProvider.ts";

const requireForKeyring = NodeModule.createRequire(import.meta.url);

export const ClaudeCredentialKeychain = Context.Reference<
  (service: string, username: string) => Promise<string | null | undefined>
>("t3/ClaudeCredentialKeychain", {
  defaultValue: () => async (service, username) => {
    const { AsyncEntry } = requireForKeyring(
      "@napi-rs/keyring",
    ) as typeof import("@napi-rs/keyring");
    return new AsyncEntry(service, username).getPassword();
  },
});
const Credentials = Schema.fromJsonString(
  Schema.Struct({
    claudeAiOauth: Schema.optional(Schema.Struct({ accessToken: Schema.optional(Schema.String) })),
  }),
);
const decodeCredentials = Schema.decodeOption(Credentials);
const Profile = Schema.Struct({
  account: Schema.Struct({ uuid: Schema.NonEmptyString, email: Schema.NonEmptyString }),
  organization: Schema.Struct({ uuid: Schema.NonEmptyString }),
});

const Window = Schema.Struct({
  utilization: Schema.Number,
  resets_at: Schema.NullOr(Schema.String),
});
const Usage = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(Window)),
  seven_day: Schema.optional(Schema.NullOr(Window)),
  spend: Schema.optional(Schema.Unknown),
  extra_usage: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        is_enabled: Schema.Boolean,
        monthly_limit: Schema.NullOr(Schema.Number),
        used_credits: Schema.NullOr(Schema.Number),
        utilization: Schema.NullOr(Schema.Number),
      }),
    ),
  ),
  limits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        percent: Schema.optional(Schema.NullOr(Schema.Number)),
        resets_at: Schema.optional(Schema.NullOr(Schema.String)),
        scope: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              model: Schema.optional(Schema.NullOr(Schema.Struct({ display_name: Schema.String }))),
            }),
          ),
        ),
      }),
    ),
  ),
});

interface AuthenticatedIdentity {
  readonly email: string;
  readonly workspaceId: string;
  readonly credentialFingerprint: string;
  readonly usage: ClaudeCapabilitiesProbe["usage"];
  readonly usageCheckedAt: string;
}

/** Config files and CLI account metadata can survive a credential switch. Only the token's profile proves ownership. */
export const readClaudeAuthenticatedIdentity = Effect.fn("readClaudeAuthenticatedIdentity")(
  function* (configDir: string, environment: NodeJS.ProcessEnv) {
    const baseUrl = environment.ANTHROPIC_BASE_URL?.trim().replace(/\/+$/, "");
    const alternateProvider = [
      environment.CLAUDE_CODE_USE_BEDROCK,
      environment.CLAUDE_CODE_USE_VERTEX,
      environment.CLAUDE_CODE_USE_FOUNDRY,
    ].some((value) => value === "1" || value?.toLowerCase() === "true");
    if (
      environment.ANTHROPIC_API_KEY?.trim() ||
      environment.ANTHROPIC_AUTH_TOKEN?.trim() ||
      (baseUrl && baseUrl !== "https://api.anthropic.com") ||
      alternateProvider
    )
      return undefined;
    const digester = yield* Digest.Digest;
    let token = environment.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (!token) {
      let raw: string | null | undefined;
      if ((yield* HostProcess.Platform) === "darwin") {
        const keychainDir =
          environment.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? environment.CLAUDE_CONFIG_DIR;
        const suffix = keychainDir
          ? `-${Hex.encode(yield* digester.digest(Digest.sha256, new TextEncoder().encode(keychainDir.normalize("NFC")))).slice(0, 8)}`
          : "";
        const username = environment.USER || (yield* HostProcess.Username);
        if (!username) return undefined;
        const readKeychain = yield* ClaudeCredentialKeychain;
        raw = yield* Effect.tryPromise(() =>
          readKeychain(`Claude Code-credentials${suffix}`, username),
        );
      }
      // Session profiles may be seeded with a file before Claude's first Keychain write.
      // A rejected Keychain read exits above; only an absent entry permits the file fallback.
      if (!raw) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        raw = yield* fs.readFileString(path.join(configDir, ".credentials.json"));
      }
      if (!raw) return undefined;
      // Schema errors contain their input. Keep malformed credential documents out of traced failures.
      const credentials = decodeCredentials(raw);
      if (Option.isNone(credentials)) return undefined;
      token = credentials.value.claudeAiOauth?.accessToken?.trim();
    }
    if (!token) return undefined;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get("https://api.anthropic.com/api/oauth/profile").pipe(
        HttpClientRequest.setHeaders({
          authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        }),
      ),
    );
    const profile = yield* HttpClientResponse.schemaBodyJson(Profile)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    // Capture one token above and use it for both calls, even if another session switches the default login meanwhile.
    const usage = yield* client
      .execute(
        HttpClientRequest.get("https://api.anthropic.com/api/oauth/usage", {
          urlParams: { cedar_ember: "1", skip_spend: "1" },
        }).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${token}`,
            "anthropic-beta": "oauth-2025-04-20",
          }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Usage)),
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => undefined),
      );
    const model_scoped = (usage?.limits ?? []).flatMap((limit) =>
      limit.kind === "weekly_scoped" && limit.scope?.model && typeof limit.percent === "number"
        ? [
            {
              display_name: limit.scope.model.display_name,
              utilization: limit.percent,
              resets_at: limit.resets_at ?? null,
            },
          ]
        : [],
    );
    const rateLimits = usage
      ? {
          five_hour: usage.five_hour ?? null,
          seven_day: usage.seven_day ?? null,
          seven_day_opus: null,
          extra_usage: usage.extra_usage ?? null,
          model_scoped,
          spend: usage.spend,
        }
      : undefined;
    return {
      email: profile.account.email,
      workspaceId: profile.organization.uuid,
      usageCheckedAt: DateTime.formatIso(yield* DateTime.now),
      usage: rateLimits
        ? {
            rate_limits_available: true,
            rate_limits: rateLimits,
          }
        : undefined,
      credentialFingerprint: Hex.encode(
        yield* digester.digest(Digest.sha256, new TextEncoder().encode(token)),
      ),
    } satisfies AuthenticatedIdentity;
  },
  Effect.timeout("10 seconds"),
  Effect.orElseSucceed(() => undefined),
);

export function bindClaudeUsageIdentity(
  capabilities: ClaudeCapabilitiesProbe,
  identity: AuthenticatedIdentity | undefined,
): ClaudeCapabilitiesProbe {
  const metadata = { ...capabilities };
  delete metadata.usage;
  delete metadata.usageCheckedAt;
  return {
    ...metadata,
    email: identity?.email,
    workspaceId: identity?.workspaceId,
    ...(identity?.usage ? { usage: identity.usage, usageCheckedAt: identity.usageCheckedAt } : {}),
  };
}
