import { describe, expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
  type ModelSelection,
} from "@t3tools/contracts";
import { claudeAccountFailover } from "./claudeAccountFailover.ts";

const now = Date.parse("2026-11-04T16:00:00Z");
function provider(id: string, used = 0): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    checkedAt: "2026-11-04T16:00:00Z",
    auth: {
      status: "authenticated",
      type: "subscription",
      email: `${id}@example.com`,
      workspaceId: id,
    },
    models: [{ slug: "opus", name: "Opus", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-11-04T16:00:00Z",
      windows: [
        { id: "five_hour", kind: "session", label: "Session", usedPercent: used },
        { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 0 },
      ],
    },
  };
}
const selection = {
  instanceId: ProviderInstanceId.make("primary"),
  model: "opus",
} as ModelSelection;
describe("Claude account failover", () => {
  it("preserves the model and selects a distinct measured subscription", () => {
    expect(
      claudeAccountFailover(selection, [provider("primary", 100), provider("second")], now),
    ).toEqual({ ...selection, instanceId: "second" });
  });
  it.each(["five_hour", "seven_day"])("refuses exhausted %s accounts", (id) => {
    const target = provider("second");
    const exhausted = {
      ...target,
      usageLimits: {
        ...target.usageLimits!,
        windows: target.usageLimits!.windows.map((window) => ({
          ...window,
          usedPercent: window.id === id ? 100 : 0,
        })),
      },
    };
    expect(claudeAccountFailover(selection, [provider("primary"), exhausted], now)).toBeNull();
  });
  it("refuses unknown, stale, same-login and already-blocked accounts", () => {
    const source = provider("primary");
    const target = provider("second");
    for (const candidate of [
      { ...target, usageLimits: undefined },
      {
        ...target,
        usageLimits: { ...target.usageLimits!, unavailable: { reason: "probeFailed" as const } },
      },
      {
        ...target,
        usageLimits: { ...target.usageLimits!, checkedAt: "2026-11-04T15:58:59Z" },
      },
      { ...target, auth: source.auth },
      { ...target, auth: { status: "unknown" as const } },
    ])
      expect(claudeAccountFailover(selection, [source, candidate], now)).toBeNull();
    expect(
      claudeAccountFailover(selection, [source, target], now, new Set([target.instanceId])),
    ).toBeNull();
  });
});
