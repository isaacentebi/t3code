import { useAtomValue } from "@effect/atom-react";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  createLinkedPullRequestSummaryAtomFamily,
  createPullRequestEnvironmentAtoms,
  createPullRequestStackAtomFamily,
} from "@t3tools/client-runtime/state/pull-requests";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestChecks,
  PullRequestDetail,
  PullRequestListInput,
  PullRequestFilterOptionsInput,
  PullRequestListStatsInput,
  PullRequestListEntry,
  PullRequestRef,
  PullRequestSummary,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import { resolvePullRequestDetailChecks } from "@t3tools/client-runtime/pull-request-checks";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  mergePullRequestLists,
  type EnvironmentPullRequestStat,
  type MergedPullRequestList,
} from "../components/pullRequest/pullRequestList.logic";
import { writePullRequestDetailSnapshot } from "../components/pullRequest/pullRequestDetail.logic";
import { pullRequestChecksState } from "../components/pullRequest/pullRequestPresentation";
import { formatEnvironmentQueryError } from "./query";
import { environmentThreadShells } from "./threads";

export interface ObservedPullRequestSummary {
  readonly summary: PullRequestSummary;
  /** Client arrival time, the only ordering older servers leave us for same-dated snapshots. */
  readonly observedAt: number;
}

const observedPullRequestSummaryAtom = Atom.family((key: string) =>
  Atom.make<ObservedPullRequestSummary | null>(null).pipe(
    Atom.setIdleTTL(5 * 60_000),
    Atom.withLabel(`web-pull-requests:observed-summary:${key}`),
  ),
);

function compareSummaries(current: PullRequestSummary, incoming: PullRequestSummary): number {
  const merged = Number(incoming.state === "merged") - Number(current.state === "merged");
  if (merged !== 0) return merged;
  const updated = Date.parse(incoming.updatedAt) - Date.parse(current.updatedAt);
  if (updated !== 0) return updated;
  if (current.observedAt === undefined && incoming.observedAt === undefined) return 0;
  return (incoming.observedAt ?? -Infinity) - (current.observedAt ?? -Infinity);
}

export function newestPullRequestSummary(
  current: PullRequestSummary | null,
  observed: PullRequestSummary | null,
): PullRequestSummary | null {
  if (current === null) return observed;
  if (observed === null) return current;
  return compareSummaries(current, observed) >= 0 ? observed : current;
}

export function pullRequestListEntryToSummary(entry: PullRequestListEntry): PullRequestSummary {
  return {
    provider: entry.provider,
    projectId: entry.projectId,
    repository: entry.repository,
    number: entry.number,
    title: entry.title,
    url: entry.url,
    state: entry.state,
    isDraft: entry.isDraft,
    headBranch: entry.headBranch,
    baseBranch: entry.baseBranch,
    updatedAt: entry.updatedAt,
    ...(entry.observedAt === undefined ? {} : { observedAt: entry.observedAt }),
    author: entry.author,
    ...(entry.reviewDecision === undefined ? {} : { reviewDecision: entry.reviewDecision }),
    ...(entry.checksState === undefined ? {} : { checksState: entry.checksState }),
    mergeability: entry.mergeability,
  };
}

// Project ids pin the remote host; omit host so legacy, URL, and list references share entries.
function pullRequestSummaryKey(environmentId: EnvironmentId, reference: PullRequestRef): string {
  return JSON.stringify([
    environmentId,
    reference.projectId,
    reference.repository.toLowerCase(),
    reference.number,
  ]);
}

export function newestPullRequestObservation(
  current: ObservedPullRequestSummary | null,
  incoming: ObservedPullRequestSummary | null,
): ObservedPullRequestSummary | null {
  if (current === null) return incoming;
  if (incoming === null) return current;
  let order = compareSummaries(current.summary, incoming.summary);
  if (
    order === 0 &&
    current.summary.observedAt === undefined &&
    incoming.summary.observedAt === undefined
  ) {
    order = incoming.observedAt - current.observedAt;
  }
  if (!(order > 0)) return current;
  // A sparse summary must not erase known status, or carry old detail stats into a new list read.
  return {
    ...incoming,
    summary: {
      ...incoming.summary,
      isDraft: incoming.summary.isDraft ?? current.summary.isDraft,
      mergeability: incoming.summary.mergeability ?? current.summary.mergeability,
      reviewDecision:
        incoming.summary.reviewDecision === undefined
          ? current.summary.reviewDecision
          : incoming.summary.reviewDecision,
      checksState:
        incoming.summary.checksState === undefined
          ? current.summary.checksState
          : incoming.summary.checksState,
    },
  };
}

function observePullRequestSummary(
  registry: AtomRegistry.AtomRegistry,
  key: string,
  summary: PullRequestSummary,
  observedAt: number,
): void {
  registry.modify(observedPullRequestSummaryAtom(key), (previous) => {
    const next = newestPullRequestObservation(previous, { summary, observedAt });
    return next === previous ? [false, previous] : [true, next];
  });
}

interface Answered<A> {
  readonly value: A;
  readonly at: number;
}

export interface LivePullRequestAnswers {
  readonly detail: Answered<PullRequestDetail> | null;
  readonly checks: Answered<PullRequestChecks | null> | null;
}

/** Detail answers carry checks too, so whichever of the two arrived last decides them. */
export function livePullRequestObservation(
  answers: LivePullRequestAnswers,
): ObservedPullRequestSummary | null {
  const { detail, checks } = answers;
  if (detail === null) return null;
  const live = resolvePullRequestDetailChecks(
    detail.value,
    checks?.value ?? null,
    checks !== null && checks.at >= detail.at,
  );
  if (live === null) return null;
  // Checks are reread far more often than detail. Ordered by the detail's read time, a newer
  // checks read would tie with the summary that detail already placed and be dropped; ordered by
  // its own, a list read taken before it still loses.
  const checksReadAt = live === detail.value ? undefined : checks?.value?.observedAt;
  const observedAt =
    checksReadAt === undefined ? live.observedAt : Math.max(live.observedAt ?? 0, checksReadAt);
  return {
    summary: {
      ...live,
      ...(observedAt === undefined ? {} : { observedAt }),
      checksState: pullRequestChecksState(live.checks),
    },
    observedAt: Math.max(detail.at, checks?.at ?? 0),
  };
}

const livePullRequestAnswersAtom = Atom.family((key: string) =>
  Atom.make<LivePullRequestAnswers>({ detail: null, checks: null }).pipe(
    Atom.setIdleTTL(5 * 60_000),
    Atom.withLabel(`web-pull-requests:live-answers:${key}`),
  ),
);

function recordLiveAnswer(
  registry: AtomRegistry.AtomRegistry,
  key: string,
  patch: Partial<LivePullRequestAnswers>,
): void {
  const atom = livePullRequestAnswersAtom(key);
  const answers = { ...registry.get(atom), ...patch };
  registry.set(atom, answers);
  const observation = livePullRequestObservation(answers);
  if (observation !== null) {
    observePullRequestSummary(registry, key, observation.summary, observation.observedAt);
  }
}

function snapshotStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

// Answers are stamped on arrival: older servers leave no other ordering for same-dated reads.
export const pullRequestEnvironment = createPullRequestEnvironmentAtoms(connectionAtomRuntime, {
  list: ({ environmentId }, answer, registry) =>
    Effect.map(Clock.currentTimeMillis, (observedAt) => {
      for (const entry of answer.entries) {
        observePullRequestSummary(
          registry,
          pullRequestSummaryKey(environmentId, entry),
          pullRequestListEntryToSummary(entry),
          observedAt,
        );
      }
    }),
  detail: ({ environmentId, input }, detail, registry) =>
    Effect.map(Clock.currentTimeMillis, (at) => {
      // Only fresh reads seed the cold-start snapshot; a stale one could replace a newer record.
      if (input.allowStale === false) {
        writePullRequestDetailSnapshot(snapshotStorage(), environmentId, input, detail);
      }
      recordLiveAnswer(registry, pullRequestSummaryKey(environmentId, input), {
        detail: { value: detail, at },
      });
    }),
  checks: ({ environmentId, input }, checks, registry) =>
    Effect.map(Clock.currentTimeMillis, (at) =>
      recordLiveAnswer(registry, pullRequestSummaryKey(environmentId, input), {
        checks: { value: checks, at },
      }),
    ),
});

export const linkedPullRequestDetailAtom = createLinkedPullRequestSummaryAtomFamily(
  connectionAtomRuntime,
  pullRequestEnvironment.refreshes,
  ({ environmentId, input }, summary, registry) =>
    Effect.map(Clock.currentTimeMillis, (observedAt) =>
      observePullRequestSummary(
        registry,
        pullRequestSummaryKey(environmentId, input),
        summary,
        observedAt,
      ),
    ),
);

export function threadPullRequestLinkToSummary(
  link: ThreadPullRequestLink,
  projectId: ProjectId,
): PullRequestSummary | null {
  const updatedAt = link.snapshot?.updatedAt;
  if (link.snapshot === null || updatedAt == null) return null;
  return {
    ...link.snapshot,
    provider: (
      sourceControlClients.findByChangeRequestUrl(link.url) ?? sourceControlClients.get(undefined)
    ).kind,
    projectId,
    repository: link.repository,
    number: link.number,
    url: link.url,
    updatedAt,
  };
}

function savedPullRequestKey(
  environmentId: EnvironmentId,
  reference: Pick<PullRequestRef, "host" | "repository" | "number">,
): string {
  return reference.host === undefined
    ? ""
    : `${environmentId}:${threadPullRequestKeyOf({ ...reference, host: reference.host })}`;
}

const savedPullRequestSummariesAtom = Atom.make((get) => {
  const summaries = new Map<string, PullRequestSummary>();
  for (const thread of get(environmentThreadShells.threadShellsAtom)) {
    for (const link of visibleThreadPullRequests(thread.pullRequests)) {
      const summary = threadPullRequestLinkToSummary(link, thread.projectId);
      if (summary === null) continue;
      const key = savedPullRequestKey(thread.environmentId, link);
      summaries.set(key, newestPullRequestSummary(summaries.get(key) ?? null, summary) ?? summary);
    }
  }
  return summaries;
});

const savedPullRequestSummaryAtom = Atom.family((key: string) =>
  Atom.make((get) => get(savedPullRequestSummariesAtom).get(key) ?? null).pipe(
    Atom.withEquality((previous, next) => JSON.stringify(previous) === JSON.stringify(next)),
    Atom.setIdleTTL(5 * 60_000),
  ),
);

/** The newest of every list, detail, checks and linked-summary answer and the thread's saved link. */
export function useSharedPullRequestSummary(
  environmentId: EnvironmentId | null,
  reference: PullRequestRef | null,
): PullRequestSummary | null {
  const key =
    environmentId === null || reference === null
      ? "none"
      : pullRequestSummaryKey(environmentId, reference);
  const observed = useAtomValue(observedPullRequestSummaryAtom(key));
  const saved = useAtomValue(
    savedPullRequestSummaryAtom(
      environmentId === null || reference === null
        ? ""
        : savedPullRequestKey(environmentId, reference),
    ),
  );
  return newestPullRequestSummary(observed?.summary ?? null, saved);
}
export const pullRequestStackAtom = createPullRequestStackAtomFamily(
  connectionAtomRuntime,
  pullRequestEnvironment.refreshes,
);

export interface EnvironmentQueryTarget<Input> {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}

interface MergedEnvironmentQueryView<A> {
  readonly values: ReadonlyArray<readonly [EnvironmentId, A]>;
  readonly error: string | null;
  readonly isPending: boolean;
}

// Use one derived atom for variable fan-out; unreachable environments must not hide other rows.
function createMergedEnvironmentQuery<Input, A>(
  label: string,
  atomFor: (
    target: EnvironmentQueryTarget<Input>,
  ) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
) {
  const family = Atom.family((key: string) =>
    Atom.make((get): MergedEnvironmentQueryView<A> => {
      const targets = JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>;
      const values: Array<readonly [EnvironmentId, A]> = [];
      let error: string | null = null;
      let isPending = false;
      for (const target of targets) {
        const result = get(atomFor(target));
        isPending ||= result.waiting;
        if (result._tag === "Failure" && error === null) {
          error = formatEnvironmentQueryError(result.cause);
        }
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value !== null) values.push([target.environmentId, value]);
      }
      return { values, error, isPending };
    }).pipe(Atom.withLabel(`${label}:${key}`)),
  );
  const empty = Atom.make<MergedEnvironmentQueryView<A>>({
    values: [],
    error: null,
    isPending: false,
  }).pipe(Atom.withLabel(`${label}:empty`));
  return function useMergedQuery(targets: ReadonlyArray<EnvironmentQueryTarget<Input>>) {
    const key = JSON.stringify(targets);
    const view = useAtomValue(targets.length === 0 ? empty : family(key));
    const refresh = (override?: ReadonlyArray<EnvironmentQueryTarget<Input>>) => {
      const refreshTargets =
        override ?? (JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>);
      for (const atom of new Set(refreshTargets.map(atomFor))) {
        appAtomRegistry.refresh(atom);
      }
    };
    return { ...view, refresh };
  };
}

const usePullRequestListsQuery = createMergedEnvironmentQuery(
  "web-pull-requests:list",
  pullRequestEnvironment.list,
);

const usePullRequestStatsQuery = createMergedEnvironmentQuery(
  "web-pull-requests:list-stats",
  pullRequestEnvironment.listStats,
);

const usePullRequestFilterOptionsQuery = createMergedEnvironmentQuery(
  "web-pull-requests:filter-options",
  pullRequestEnvironment.filterOptions,
);

const usePullRequestTurnRefreshQuery = createMergedEnvironmentQuery(
  "web-pull-requests:turn-refreshes",
  ({ environmentId }: EnvironmentQueryTarget<Readonly<Record<string, never>>>) =>
    pullRequestEnvironment.refreshes({ environmentId, input: {} }),
);

export function usePullRequestTurnRefreshes(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<readonly [EnvironmentId, number]> {
  return usePullRequestTurnRefreshQuery(
    environmentIds.map((environmentId) => ({ environmentId, input: {} })),
  ).values;
}

export function usePullRequestTurnRefresh(environmentId: EnvironmentId): number | null {
  const result = useAtomValue(pullRequestEnvironment.refreshes({ environmentId, input: {} }));
  return Option.getOrNull(AsyncResult.value(result));
}

export interface MergedPullRequestListView {
  readonly data: MergedPullRequestList | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: (targets?: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>>) => void;
}

export function usePullRequestList(
  targets: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>>,
): MergedPullRequestListView {
  const query = usePullRequestListsQuery(targets);
  const data = mergePullRequestLists(query.values);
  return { data, error: query.error, isPending: query.isPending, refresh: query.refresh };
}

export function usePullRequestListStats(
  targets: ReadonlyArray<EnvironmentQueryTarget<PullRequestListStatsInput>>,
): {
  readonly stats: ReadonlyArray<EnvironmentPullRequestStat> | null;
  readonly isPending: boolean;
  readonly refresh: (
    targets?: ReadonlyArray<EnvironmentQueryTarget<PullRequestListStatsInput>>,
  ) => void;
} {
  const query = usePullRequestStatsQuery(targets);
  const stats =
    query.values.length === 0
      ? null
      : query.values.flatMap(([environmentId, result]) =>
          result.stats.map((stat) => ({ ...stat, environmentId })),
        );
  return { stats, isPending: query.isPending, refresh: query.refresh };
}

export function usePullRequestFilterOptions(
  targets: ReadonlyArray<EnvironmentQueryTarget<PullRequestFilterOptionsInput>>,
) {
  const query = usePullRequestFilterOptionsQuery(targets);
  return {
    labels: query.values.flatMap(([, options]) => options.labels),
    authors: query.values.flatMap(([, options]) => options.authors),
    error: query.error,
    isPending: query.isPending,
  };
}
