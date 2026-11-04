import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
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
