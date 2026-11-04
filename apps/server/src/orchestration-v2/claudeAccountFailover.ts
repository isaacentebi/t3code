import type { ModelSelection, ServerProvider, ProviderInstanceId } from "@t3tools/contracts";

/** Never select an API key, an unidentified login, or a partially measured subscription. */
export function claudeAccountFailover(
  current: ModelSelection,
  providers: readonly ServerProvider[],
  nowMs: number,
  blocked: ReadonlySet<ProviderInstanceId> = new Set(),
): ModelSelection | null {
  const source = providers.find((provider) => provider.instanceId === current.instanceId);
  if (source?.driver !== "claudeAgent" || !source.auth.email || !source.auth.workspaceId)
    return null;
  for (const target of providers) {
    const limits = target.usageLimits;
    if (
      target.instanceId === source.instanceId ||
      blocked.has(target.instanceId) ||
      target.driver !== source.driver ||
      !target.enabled ||
      !target.installed ||
      target.status !== "ready" ||
      target.auth.status !== "authenticated" ||
      target.auth.type !== source.auth.type ||
      !target.auth.email ||
      !target.auth.workspaceId ||
      target.auth.email.toLowerCase() === source.auth.email.toLowerCase() ||
      target.auth.workspaceId === source.auth.workspaceId ||
      !target.models.some((model) => model.slug === current.model) ||
      !limits ||
      limits.unavailable ||
      !Number.isFinite(Date.parse(limits.checkedAt)) ||
      nowMs - Date.parse(limits.checkedAt) > 60_000 ||
      Date.parse(limits.checkedAt) > nowMs
    )
      continue;
    if (
      !["five_hour", "seven_day"].every((id) => limits.windows.some((window) => window.id === id))
    )
      continue;
    if (limits.windows.some((window) => window.usedPercent >= 100)) continue;
    return { ...current, instanceId: target.instanceId };
  }
  return null;
}

export function blockedClaudeAccounts(
  projection: Pick<
    import("@t3tools/contracts").OrchestrationV2ThreadProjection,
    "runs" | "turnItems"
  >,
  nowMs: number,
): ReadonlySet<ProviderInstanceId> {
  const blocked = new Set<ProviderInstanceId>();
  for (const item of projection.turnItems) {
    if (
      item.type !== "error" ||
      item.failure?.class !== "usage_limit" ||
      !item.failure.resetAt ||
      Date.parse(item.failure.resetAt) <= nowMs
    )
      continue;
    const run = projection.runs.find((run) => run.id === item.runId);
    if (run && item.nodeId === run.rootNodeId) blocked.add(run.providerInstanceId);
  }
  return blocked;
}
