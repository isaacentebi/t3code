import { reportAtomCommandResult, settlePromise } from "../state/runtime.ts";

/**
 * The slice of a Clerk instance the account service needs. Clerk emits on
 * every resource change (token refreshes, profile edits), so the service
 * dedupes emissions down to account changes.
 */
export interface CloudAccountSource {
  readonly addListener: (
    listener: (resources: { readonly user?: { readonly id: string } | null | undefined }) => void,
  ) => () => void;
}

export type CloudAccountStep =
  | { readonly _tag: "None" }
  | {
      readonly _tag: "SignOut";
      /** Account whose data is removed; null removes data of any account. */
      readonly previousAccountId: string | null;
    }
  | {
      readonly _tag: "SignIn";
      readonly accountId: string;
      /** Signed-in account being replaced; its data is removed before activation. */
      readonly switchFromAccountId: string | null;
    };

/**
 * `previous` is undefined until Clerk's first emission. A first emission that
 * is signed out still cleans up, so data left by an account that signed out
 * while the app was closed does not linger.
 */
export function planCloudAccountStep(
  previous: string | null | undefined,
  next: string | null,
): CloudAccountStep {
  if (previous === next) return { _tag: "None" };
  if (next === null) return { _tag: "SignOut", previousAccountId: previous ?? null };
  return { _tag: "SignIn", accountId: next, switchFromAccountId: previous ?? null };
}

export interface CloudAccountHandlers<S extends CloudAccountSource> {
  /** Synchronously drops every credential so nothing reads the old account during cleanup. */
  readonly deactivate: () => void;
  /**
   * Removes the data of `accountId`. A switch activates the next account only
   * after this resolves.
   */
  readonly cleanUp: (input: { readonly accountId: string | null }) => Promise<void>;
  readonly activate: (input: { readonly source: S; readonly accountId: string }) => void;
  /** Releases credentials when the service stops observing a Clerk instance. */
  readonly detach: () => void;
}

export interface CloudAccountService<S extends CloudAccountSource> {
  /**
   * Observes `source` until the returned function runs. Attaching while another
   * source is attached detaches that one first.
   */
  readonly attach: (source: S) => () => void;
}

export function createCloudAccountService<S extends CloudAccountSource>(
  handlers: CloudAccountHandlers<S>,
): CloudAccountService<S> {
  let attached: { readonly source: S; readonly unsubscribe: () => void } | null = null;
  // undefined until the attached source's first emission.
  let observedAccount: string | null | undefined = undefined;
  // Bumped on every account change so a superseded activation never applies.
  let generation = 0;
  let tail: Promise<void> = Promise.resolve();

  const enqueue = (label: string, operation: () => Promise<void>) => {
    const run = tail.then(operation, operation);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    void settlePromise(() => run).then((result) => reportAtomCommandResult(result, { label }));
  };

  const observe = (source: S, next: string | null) => {
    const step = planCloudAccountStep(observedAccount, next);
    if (step._tag === "None") return;
    observedAccount = next;
    generation += 1;
    const activation = generation;

    if (step._tag === "SignOut") {
      handlers.deactivate();
      enqueue("cloud account cleanup", () =>
        handlers.cleanUp({ accountId: step.previousAccountId }),
      );
      return;
    }

    if (step.switchFromAccountId !== null) handlers.deactivate();
    enqueue("cloud account activation", async () => {
      if (step.switchFromAccountId !== null) {
        await handlers.cleanUp({ accountId: step.switchFromAccountId });
      }
      if (activation !== generation) return;
      handlers.activate({ source, accountId: step.accountId });
    });
  };

  const detach = () => {
    if (!attached) return;
    attached.unsubscribe();
    attached = null;
    generation += 1;
    observedAccount = undefined;
    handlers.detach();
  };

  return {
    attach(source) {
      detach();
      const current = {
        source,
        unsubscribe: source.addListener((resources) => {
          // Clerk reports `user: undefined` until it loads; pending sessions
          // still carry a user and count as signed in.
          if (resources.user === undefined) return;
          observe(source, resources.user?.id ?? null);
        }),
      };
      attached = current;
      return () => {
        if (attached === current) detach();
      };
    },
  };
}
