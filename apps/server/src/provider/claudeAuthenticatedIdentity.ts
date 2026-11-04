import * as Crypto from "effect/Crypto";
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

interface AuthenticatedIdentity {
  readonly email: string;
  readonly workspaceId: string;
  readonly credentialFingerprint: string;
}

/** Config files and CLI account metadata can survive a credential switch. Only the token's profile proves ownership. */
export const readClaudeAuthenticatedIdentity = Effect.fn("readClaudeAuthenticatedIdentity")(
  function* (configDir: string, environment: NodeJS.ProcessEnv) {
    if (environment.ANTHROPIC_API_KEY?.trim() || environment.ANTHROPIC_AUTH_TOKEN?.trim())
      return undefined;
    const crypto = yield* Crypto.Crypto;
    let token = environment.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (!token) {
      let raw: string | null | undefined;
      if ((yield* HostProcess.Platform) === "darwin") {
        const keychainDir =
          environment.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? environment.CLAUDE_CONFIG_DIR;
        const suffix = keychainDir
          ? `-${Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(keychainDir.normalize("NFC")))).slice(0, 8)}`
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
    return {
      email: profile.account.email,
      workspaceId: profile.organization.uuid,
      credentialFingerprint: Hex.encode(
        yield* crypto.digest("SHA-256", new TextEncoder().encode(token)),
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
  const { usage, usageCheckedAt, ...metadata } = capabilities;
  const matches =
    identity && capabilities.email?.trim().toLowerCase() === identity.email.trim().toLowerCase();
  return {
    ...metadata,
    email: identity?.email,
    workspaceId: identity?.workspaceId,
    ...(matches && usage ? { usage, usageCheckedAt } : {}),
  };
}
