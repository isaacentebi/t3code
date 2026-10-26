import { describe, expect, it } from "vite-plus/test";

import {
  type CloudAccountSource,
  createCloudAccountService,
  planCloudAccountStep,
} from "./cloudAccountService.ts";

type Emit = (user: { readonly id: string } | null | undefined) => void;

function makeSource() {
  let listener: Parameters<CloudAccountSource["addListener"]>[0] | null = null;
  const source: CloudAccountSource = {
    addListener: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  const emit: Emit = (user) => listener?.({ user });
  return { source, emit, isSubscribed: () => listener !== null };
}

function makeService() {
  const log: string[] = [];
  const activated: Array<PromiseWithResolvers<void>> = [];
  const cleanedUp: Array<PromiseWithResolvers<void>> = [];
  const cleanUpGates = new Map<string, PromiseWithResolvers<void>>();
  const service = createCloudAccountService<CloudAccountSource>({
    deactivate: () => log.push("deactivate"),
    detach: () => log.push("detach"),
    cleanUp: async ({ accountId }) => {
      log.push(`cleanUp:${accountId}`);
      await cleanUpGates.get(accountId ?? "")?.promise;
      cleanedUp.shift()?.resolve();
    },
    activate: ({ accountId }) => {
      log.push(`activate:${accountId}`);
      activated.shift()?.resolve();
    },
  });
  const nextActivation = () => {
    const deferred = Promise.withResolvers<void>();
    activated.push(deferred);
    return deferred.promise;
  };
  const nextCleanUp = () => {
    const deferred = Promise.withResolvers<void>();
    cleanedUp.push(deferred);
    return deferred.promise;
  };
  const holdCleanUp = (accountId: string) => {
    const deferred = Promise.withResolvers<void>();
    cleanUpGates.set(accountId, deferred);
    return deferred;
  };
  return { service, log, nextActivation, nextCleanUp, holdCleanUp };
}

describe("planCloudAccountStep", () => {
  it("plans the first observation from no previous account", () => {
    expect(planCloudAccountStep(undefined, "a")).toEqual({
      _tag: "SignIn",
      accountId: "a",
      switchFromAccountId: null,
    });
    expect(planCloudAccountStep(undefined, null)).toEqual({
      _tag: "SignOut",
      previousAccountId: null,
    });
  });

  it("ignores repeats and switches from the previous account", () => {
    expect(planCloudAccountStep("a", "a")).toEqual({ _tag: "None" });
    expect(planCloudAccountStep(null, null)).toEqual({ _tag: "None" });
    expect(planCloudAccountStep("a", "b")).toEqual({
      _tag: "SignIn",
      accountId: "b",
      switchFromAccountId: "a",
    });
  });
});

describe("createCloudAccountService", () => {
  it("activates once per account however often Clerk emits", async () => {
    const { service, log, nextActivation } = makeService();
    const { source, emit } = makeSource();
    service.attach(source);

    emit(undefined);
    expect(log).toEqual([]);
    const activation = nextActivation();
    emit({ id: "a" });
    emit({ id: "a" });
    await activation;
    emit({ id: "a" });

    expect(log).toEqual(["activate:a"]);
  });

  it("drops credentials synchronously and cleans up before activating the next account", async () => {
    const { service, log, nextActivation } = makeService();
    const { source, emit } = makeSource();
    service.attach(source);
    const first = nextActivation();
    emit({ id: "a" });
    await first;
    log.length = 0;

    const second = nextActivation();
    emit({ id: "b" });
    expect(log).toEqual(["deactivate"]);
    await second;

    expect(log).toEqual(["deactivate", "cleanUp:a", "activate:b"]);
  });

  it("cleans up on sign-out, including a signed-out first observation", async () => {
    const { service, log, nextActivation, nextCleanUp } = makeService();
    const { source, emit } = makeSource();
    service.attach(source);

    const initialCleanUp = nextCleanUp();
    emit(null);
    await initialCleanUp;
    expect(log).toEqual(["deactivate", "cleanUp:null"]);

    const activation = nextActivation();
    emit({ id: "a" });
    await activation;
    log.length = 0;

    const cleanUp = nextCleanUp();
    emit(null);
    await cleanUp;
    expect(log).toEqual(["deactivate", "cleanUp:a"]);
  });

  it("never activates an account that signed out while it was activating", async () => {
    const { service, log, nextActivation, nextCleanUp, holdCleanUp } = makeService();
    const { source, emit } = makeSource();
    service.attach(source);
    const first = nextActivation();
    emit({ id: "a" });
    await first;
    log.length = 0;

    const heldCleanUp = holdCleanUp("a");
    emit({ id: "b" });
    emit(null);
    void nextCleanUp();
    const signOutCleanUp = nextCleanUp();
    heldCleanUp.resolve();
    await signOutCleanUp;

    expect(log).toEqual(["deactivate", "deactivate", "cleanUp:a", "cleanUp:b"]);
  });

  it("detaches from a replaced Clerk instance", () => {
    const { service, log } = makeService();
    const first = makeSource();
    const second = makeSource();
    service.attach(first.source);
    service.attach(second.source);

    expect(first.isSubscribed()).toBe(false);
    expect(second.isSubscribed()).toBe(true);
    expect(log).toEqual(["detach"]);
  });

  it("releases credentials and stops observing when detached", async () => {
    const { service, log, nextActivation } = makeService();
    const { source, emit, isSubscribed } = makeSource();
    const detach = service.attach(source);
    const activation = nextActivation();
    emit({ id: "a" });
    await activation;

    detach();
    expect(isSubscribed()).toBe(false);
    expect(log).toEqual(["activate:a", "detach"]);
  });
});
