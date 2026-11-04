import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Tracer from "effect/Tracer";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  ClaudeCredentialKeychain,
  bindClaudeUsageIdentity,
  readClaudeAuthenticatedIdentity,
} from "./claudeAuthenticatedIdentity.ts";
import type { ClaudeCapabilitiesProbe } from "./ClaudeProvider.ts";

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

it("does not attribute another credential's usage to stale CLI identity", () => {
  const bound = bindClaudeUsageIdentity(capabilities, {
    email: "actual@example.com",
    workspaceId: "actual-org",
    credentialFingerprint: "fingerprint",
  });
  assert.equal(bound.email, "actual@example.com");
  assert.equal(bound.workspaceId, "actual-org");
  assert.equal(bound.usage, undefined);
  assert.equal(bindClaudeUsageIdentity(capabilities, undefined).usage, undefined);
  assert.equal(bindClaudeUsageIdentity(capabilities, undefined).email, undefined);
});

it("keeps quota only when the authenticated profile and usage session agree", () => {
  assert.equal(
    bindClaudeUsageIdentity(capabilities, {
      email: "OLD@example.com",
      workspaceId: "verified-org",
      credentialFingerprint: "fingerprint",
    }).usage,
    capabilities.usage,
  );
});

it.effect("uses the actual token's profile and refuses failed profile reads", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) => {
      assert.equal(request.url, "https://api.anthropic.com/api/oauth/profile");
      assert.equal(request.headers.authorization, "Bearer test-credential");
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            account: { uuid: "actual-account", email: "actual@example.com" },
            organization: { uuid: "actual-org" },
          }),
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
  }).pipe(Effect.provide(NodeServices.layer)),
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
            Response.json({
              account: { uuid: "seed-account", email: "seed@example.com" },
              organization: { uuid: "seed-org" },
            }),
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
  ).pipe(Effect.provide(NodeServices.layer)),
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
  ).pipe(Effect.provide(NodeServices.layer)),
);
