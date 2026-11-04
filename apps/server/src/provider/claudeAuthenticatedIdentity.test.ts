import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Layer from "effect/Layer";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Tracer from "effect/Tracer";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { HttpClient, HttpClientResponse } from "effect/http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Exercise the captured Keychain subprocess boundary.
import * as NodeChildProcess from "node:child_process";
import { vi } from "vite-plus/test";

import {
  ClaudeCredentialKeychain,
  bindClaudeUsageIdentity,
  readClaudeAuthenticatedIdentity,
} from "./claudeAuthenticatedIdentity.ts";
import type { ClaudeCapabilitiesProbe } from "./ClaudeProvider.ts";

vi.mock("node:child_process", { spy: true });

it.effect("captures the macOS credential command and only treats a missing entry as absent", () =>
  Effect.gen(function* () {
    const readKeychain = yield* ClaudeCredentialKeychain;
    using probe = vi.spyOn(NodeChildProcess, "execFile");
    probe.mockImplementation((_file, _args, _options, callback) => {
      if (typeof callback !== "function") throw new Error("Expected captured callback");
      callback(null, "credential-document\n", "");
      return {} as NodeChildProcess.ChildProcess;
    });
    assert.equal(
      yield* Effect.promise(() => readKeychain("service", "user")),
      "credential-document",
    );
    assert.deepEqual(probe.mock.calls[0]?.slice(0, 3), [
      "/usr/bin/security",
      ["find-generic-password", "-a", "user", "-w", "-s", "service"],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 256 * 1024 },
    ]);
    for (const code of [44, 36, "ETIMEDOUT"]) {
      probe.mockImplementation((_file, _args, _options, callback) => {
        if (typeof callback !== "function") throw new Error("Expected captured callback");
        callback(Object.assign(new Error("sensitive process error"), { code }), "secret", "secret");
        return {} as NodeChildProcess.ChildProcess;
      });
      const result = yield* Effect.tryPromise(() => readKeychain("service", "user")).pipe(
        Effect.exit,
      );
      if (code === 44) assert.deepEqual(result, Exit.succeed(undefined));
      else {
        assert.isTrue(Exit.isFailure(result));
        assert.notInclude(JSON.stringify(result), "secret");
        assert.notInclude(JSON.stringify(result), "sensitive process error");
      }
    }
  }),
);

const freshUsage: NonNullable<ClaudeCapabilitiesProbe["usage"]> = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: null,
    seven_day: { utilization: 12, resets_at: null },
    seven_day_opus: null,
    extra_usage: null,
  },
};
const quotaResponse = { five_hour: null, seven_day: { utilization: 12, resets_at: null } };

const capabilities: ClaudeCapabilitiesProbe = {
  email: "old@example.com",
  subscriptionType: "max",
  tokenSource: "oauth",
  apiKeySource: undefined,
  apiProvider: "firstParty",
  slashCommands: [],
  usage: { rate_limits_available: true, rate_limits: null },
  usageCheckedAt: "2026-11-04T00:00:00Z",
};

it("replaces stale SDK identity and quota with the same-token authenticated reading", () => {
  const bound = bindClaudeUsageIdentity(capabilities, {
    email: "actual@example.com",
    workspaceId: "actual-org",
    credentialFingerprint: "fingerprint",
    usage: freshUsage,
    usageCheckedAt: "2026-11-04T12:00:00Z",
  });
  assert.equal(bound.email, "actual@example.com");
  assert.equal(bound.workspaceId, "actual-org");
  assert.equal(bound.usage, freshUsage);
  assert.equal(bindClaudeUsageIdentity(capabilities, undefined).usage, undefined);
  assert.equal(bindClaudeUsageIdentity(capabilities, undefined).email, undefined);
});

it("never reuses cached SDK quota for a freshly verified account", () => {
  assert.equal(
    bindClaudeUsageIdentity(capabilities, {
      email: "OLD@example.com",
      workspaceId: "verified-org",
      credentialFingerprint: "fingerprint",
      usage: freshUsage,
      usageCheckedAt: "2026-11-04T12:00:00Z",
    }).usage,
    freshUsage,
  );
});

it.effect("uses the actual token's profile and refuses failed profile reads", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) => {
      assert.isTrue(
        [
          "https://api.anthropic.com/api/oauth/profile",
          "https://api.anthropic.com/api/oauth/usage",
        ].includes(request.url),
      );
      assert.equal(request.headers.authorization, "Bearer test-credential");
      if (request.url.endsWith("/usage"))
        assert.deepEqual(Array.from(request.urlParams), [
          ["cedar_ember", "1"],
          ["skip_spend", "1"],
        ]);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            request.url.endsWith("/usage")
              ? quotaResponse
              : {
                  account: { uuid: "actual-account", email: "actual@example.com" },
                  organization: { uuid: "actual-org" },
                },
          ),
        ),
      );
    });
    const identity = yield* readClaudeAuthenticatedIdentity("/unused", {
      CLAUDE_CODE_OAUTH_TOKEN: "test-credential",
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    assert.equal(identity?.email, "actual@example.com");
    assert.equal(identity?.workspaceId, "actual-org");
    assert.notEqual(identity?.credentialFingerprint, "test-credential");
    const unauthorized = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: 401 }))),
    );
    assert.equal(
      yield* readClaudeAuthenticatedIdentity("/unused", {
        CLAUDE_CODE_OAUTH_TOKEN: "test-credential",
      }).pipe(Effect.provideService(HttpClient.HttpClient, unauthorized)),
      undefined,
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("reads a seeded session file only when its Keychain entry is absent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        `${directory}/.credentials.json`,
        JSON.stringify({ claudeAiOauth: { accessToken: "seeded-credential" } }),
      );
      const client = HttpClient.make((request) => {
        assert.equal(request.headers.authorization, "Bearer seeded-credential");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              request.url.endsWith("/usage")
                ? quotaResponse
                : {
                    account: { uuid: "seed-account", email: "seed@example.com" },
                    organization: { uuid: "seed-org" },
                  },
            ),
          ),
        );
      });
      const work = readClaudeAuthenticatedIdentity(directory, {
        USER: "test-user",
        CLAUDE_CONFIG_DIR: directory,
      }).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const identity = yield* work.pipe(
        Effect.provideService(ClaudeCredentialKeychain, async () => null),
      );
      assert.equal(identity?.email, "seed@example.com");
      const denied = yield* work.pipe(
        Effect.provideService(ClaudeCredentialKeychain, async () => {
          throw new Error("Keychain denied");
        }),
      );
      assert.equal(denied, undefined);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("malformed credential documents never enter traced error causes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const secret = "never-record-this-secret";
      yield* fs.writeFileString(
        `${directory}/.credentials.json`,
        `{"claudeAiOauth":{"accessToken":"${secret}"`,
      );
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const client = HttpClient.make(() =>
        Effect.die("malformed credentials must not send HTTP requests"),
      );
      const identity = yield* readClaudeAuthenticatedIdentity(directory, {}).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.withTracer(tracer),
      );
      assert.equal(identity, undefined);
      const failures = spans.flatMap((span) =>
        span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
          ? [Cause.pretty(span.status.exit.cause)]
          : [],
      );
      assert.equal(failures.join("\n").includes(secret), false);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "keeps identity and quota on one token while a concurrent switch changes the credential file",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const credentialsPath = `${directory}/.credentials.json`;
        const writeCredential = (accessToken: string) =>
          fs.writeFileString(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken } }));
        yield* writeCredential("account-a-token");
        let usageCalls = 0;
        const client = HttpClient.make((request) =>
          Effect.gen(function* () {
            assert.equal(request.headers.authorization, "Bearer account-a-token");
            if (request.url.endsWith("/profile")) {
              yield* writeCredential("account-b-token").pipe(Effect.orDie);
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  account: { uuid: "a", email: "a@example.com" },
                  organization: { uuid: "org-a" },
                }),
              );
            }
            usageCalls++;
            return HttpClientResponse.fromWeb(request, Response.json(quotaResponse));
          }),
        );
        const reading = yield* readClaudeAuthenticatedIdentity(directory, {}).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HttpClient.HttpClient, client),
        );
        assert.equal(reading?.email, "a@example.com");
        assert.equal(reading?.usage?.rate_limits?.seven_day?.utilization, 12);
        assert.equal(usageCalls, 1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("a usage429 preserves verified identity while publishing unknown quota", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.url.endsWith("/profile")
            ? Response.json({
                account: { uuid: "a", email: "a@example.com" },
                organization: { uuid: "org-a" },
              })
            : Response.json({}, { status: 429 }),
        ),
      ),
    );
    const reading = yield* readClaudeAuthenticatedIdentity("/unused", {
      CLAUDE_CODE_OAUTH_TOKEN: "test-token",
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    assert.equal(reading?.email, "a@example.com");
    assert.equal(reading?.workspaceId, "org-a");
    assert.equal(reading?.usage, undefined);
    assert.equal(bindClaudeUsageIdentity(capabilities, reading).usage, undefined);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("does not offer subscription quota when Claude uses API or gateway authentication", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            request.url.endsWith("/usage")
              ? quotaResponse
              : {
                  account: { uuid: "account", email: "account@example.com" },
                  organization: { uuid: "organization" },
                },
          ),
        ),
      ),
    );
    for (const override of [
      { ANTHROPIC_API_KEY: "test-api-key" },
      { ANTHROPIC_AUTH_TOKEN: "test-gateway-token" },
      { ANTHROPIC_BASE_URL: "https://gateway.example.com" },
      { CLAUDE_CODE_USE_BEDROCK: "1" },
      { CLAUDE_CODE_USE_VERTEX: "1" },
      { CLAUDE_CODE_USE_FOUNDRY: "1" },
    ]) {
      assert.isUndefined(
        yield* readClaudeAuthenticatedIdentity("/unused", {
          CLAUDE_CODE_OAUTH_TOKEN: "test-subscription-token",
          ...override,
        }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
      );
    }
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
