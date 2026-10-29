import type { ObjcRuntime } from "../../electron/MacosObjcRuntime.ts";
import { GLASS_ABI } from "./macosGlassAdapter.ts";

export function fakeObjcRuntime(
  options: {
    mismatch?: string;
    missingClass?: string;
    missingSelector?: string;
    missingMethod?: string;
    mainThread?: boolean;
    fail?: string;
  } = {},
) {
  let next = 100n;
  const names = new Map<bigint, string>();
  const ids = new Map<string, bigint>();
  const id = (name: string) => {
    let value = ids.get(name);
    if (value === undefined) {
      value = next++;
      ids.set(name, value);
      names.set(value, name);
    }
    return value;
  };
  const objects = new Map<bigint, { kind: string; live: boolean; owner?: bigint }>();
  const state = {
    liveViews: new Set<bigint>(),
    activeConstraints: new Set<bigint>(),
    tints: [] as number[][],
    allocations: 0,
    inserts: 0,
    mutations: 0,
    onTint: undefined as (() => void) | undefined,
    onRemove: undefined as (() => void) | undefined,
    fail: options.fail,
  };
  const allocate = (kind: string, owner?: bigint) => {
    const value = next++;
    objects.set(value, { kind, live: true, ...(owner === undefined ? {} : { owner }) });
    return value;
  };
  let owned = true;
  let inserted = false;
  const check = (receiver: bigint) => {
    const object = objects.get(receiver);
    if (object && (!object.live || (object.owner && !objects.get(object.owner)?.live)))
      throw new Error("Message to released native object");
  };
  const fail = (stage: string) => {
    if (state.fail === stage) {
      state.fail = undefined;
      throw new Error(`Injected ${stage} failure`);
    }
  };
  const runtime: ObjcRuntime = {
    classNamed: (name) => (name === options.missingClass ? 0n : id(name)),
    selector: (name) => (name === options.missingSelector ? 0n : id(name)),
    encoding: (cls, selector, dispatch) => {
      const method = names.get(selector);
      if (method === options.missingMethod) return null;
      if (method === options.mismatch) return "wrong-ABI";
      return (
        GLASS_ABI.find(
          ([name, kind, sel]) => names.get(cls) === name && kind === dispatch && sel === method,
        )?.[3] ?? null
      );
    },
    bool: () => options.mainThread !== false,
    pointer: (receiver, selector) => {
      check(receiver);
      const name = names.get(selector);
      if (name === "alloc") {
        if (state.fail === "alloc-null") return 0n;
        state.allocations++;
        owned = true;
        const glass = allocate("glass");
        state.liveViews.add(glass);
        return glass;
      }
      if (name === "init") {
        if (state.fail === "init-null") {
          const object = objects.get(receiver);
          if (object) object.live = false;
          state.liveViews.delete(receiver);
          return 0n;
        }
        return receiver;
      }
      if (name?.endsWith("Anchor")) {
        if (state.fail === "anchor-null") return 0n;
        return allocate("anchor", receiver === 1n ? undefined : receiver);
      }
      if (name === "constraintEqualToAnchor:") {
        if (state.fail === "constraint-null") return 0n;
        return allocate("constraint");
      }
      throw new Error("Unexpected pointer dispatch");
    },
    void: (receiver, selector, args = []) => {
      check(receiver);
      state.mutations++;
      const name = names.get(selector);
      if (name === "addSubview:positioned:relativeTo:") {
        inserted = true;
        state.inserts++;
        fail("insert");
      } else if (name === "setTintColor:") {
        fail("tint");
        state.onTint?.();
      } else if (name === "release") {
        owned = false;
        if (!inserted) {
          state.liveViews.delete(receiver);
          const object = objects.get(receiver);
          if (object) object.live = false;
        }
      } else if (name === "removeFromSuperview") {
        state.onRemove?.();
        inserted = false;
        if (!owned) {
          state.liveViews.delete(receiver);
          const object = objects.get(receiver);
          if (object) object.live = false;
        }
      } else throw new Error("Unexpected void dispatch");
      for (const arg of args) if (arg > 0n) check(arg);
    },
    setBool: (receiver, selector, value) => {
      check(receiver);
      state.mutations++;
      if (names.get(selector) === "setActive:") {
        if (value) {
          state.activeConstraints.add(receiver);
          fail("activation");
        } else {
          state.activeConstraints.delete(receiver);
          const object = objects.get(receiver);
          if (object) object.live = false;
        }
      } else fail("tamic");
    },
    color: (_receiver, _selector, rgba) => {
      if (state.fail === "color-null") return 0n;
      state.tints.push([...rgba]);
      return allocate("color");
    },
  };
  return { runtime, state };
}
