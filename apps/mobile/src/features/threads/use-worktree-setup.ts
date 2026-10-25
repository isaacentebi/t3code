import type { EnvironmentId, ThreadId, WorktreeSetupSnapshot } from "@t3tools/contracts";
import { resolveVisibleWorktreeSetup } from "@t3tools/client-runtime/worktree-setup";
import { useEffect, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { resolveWorktreeSetupSnapshot } from "./worktree-setup-state";

export function useWorktreeSetup(input: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  preparing: boolean;
  turnStarted: boolean;
  followUpSent: boolean;
}) {
  const key = JSON.stringify([input.environmentId, input.threadId]);
  const [held, setHeld] = useState<{ key: string; snapshot: WorktreeSetupSnapshot } | null>(null);
  const live = held?.key === key ? held.snapshot : null;
  const query = useEnvironmentQuery(
    input.environmentId &&
      input.threadId &&
      (live?.phase === "running" || (!live && input.preparing))
      ? vcsEnvironment.worktreeSetup({
          environmentId: input.environmentId,
          input: { threadId: input.threadId },
        })
      : null,
  );
  const snapshot = resolveWorktreeSetupSnapshot(input.threadId, query.data, live);
  /* oxlint-disable react/set-state-in-effect -- Retain the last external setup snapshot while the live subscription transitions. */
  useEffect(() => {
    if (snapshot && snapshot !== live) setHeld({ key, snapshot });
  }, [key, live, snapshot]);
  /* oxlint-enable react/set-state-in-effect */
  return {
    snapshot,
    visible: resolveVisibleWorktreeSetup({
      live: snapshot,
      recorded: null,
      turnStarted: input.turnStarted,
      followUpSent: input.followUpSent,
    }),
  };
}
