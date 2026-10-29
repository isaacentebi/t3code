import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as MacosObjcRuntime from "../../electron/MacosObjcRuntime.ts";
import * as Adapters from "./adapters.ts";
import * as Platform from "./materialPlatform.ts";
import { makeFixture } from "./materialTestFixture.ts";
import { fakeObjcRuntime } from "./macosGlassTestFixture.ts";

const imports = vi.hoisted(() => ({ ffi: 0 }));
vi.mock("ffi-rs", () => {
  imports.ffi++;
  throw new Error("Rejected environments must not import ffi-rs");
});
vi.mock("node:os", () => ({ release: () => "10.0.22621" }));
vi.mock("electron", () => ({
  BrowserWindow: class {
    setBackgroundMaterial() {}
  },
}));

const select = Effect.fn("test.materialPlatform")(function* (
  options: {
    platform?: NodeJS.Platform;
    isPackaged?: boolean;
    arch?: string;
    version?: string | null;
    native?: Parameters<typeof fakeObjcRuntime>[0];
    realLoader?: boolean;
    enabled?: boolean;
    transparent?: boolean;
    prepare?: Adapters.MaterialAdapter["prepare"];
  } = {},
) {
  const native = fakeObjcRuntime(options.native);
  let loads = 0;
  const context = yield* Layer.build(Platform.layer).pipe(
    Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
      platform: options.platform ?? "darwin",
      processArch: options.arch ?? "arm64",
      isPackaged: options.isPackaged ?? true,
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
    Effect.provideService(Platform.MacosVersion, {
      get: Effect.succeed(options.version === undefined ? "27.2" : options.version),
    }),
    Effect.provide(
      Layer.mergeAll(
        options.realLoader
          ? MacosObjcRuntime.layer
          : Layer.succeed(MacosObjcRuntime.MacosObjcRuntime, {
              load: Effect.sync(() => {
                loads++;
                return native.runtime;
              }),
            }),
        Adapters.layer,
      ),
    ),
  );
  const selection = Context.get(context, Platform.DesktopMaterialPlatform);
  let prepares = 0;
  const adapter = selection.adapter;
  const fixture = yield* makeFixture({
    selection: {
      ...selection,
      adapter:
        adapter === null
          ? null
          : {
              ...adapter,
              prepare: () => {
                prepares++;
                return options.prepare?.() ?? adapter.prepare();
              },
            },
    },
    platform: options.platform ?? "darwin",
    enabled: options.enabled,
    transparent: options.transparent,
  });
  return { ...fixture, ...native, selection, loads: () => loads, prepares: () => prepares };
});

const rejected = [
  { name: "Linux", platform: "linux" as const },
  { name: "x64", arch: "x64" },
  { name: "macOS 25", version: "25.4", reason: "os-version" },
  { name: "unknown version", version: null },
  { name: "invalid version", version: "26x" },
] as const;

describe("assembled material platform and window service", () => {
  it.effect("macOS window creation follows Liquid Glass with the system switch off", () =>
    Effect.gen(function* () {
      const f = yield* select({ enabled: false });
      assert.deepEqual(yield* f.material.windowOptions, {});
      yield* f.commit({ appearancePreset: "liquid-glass" });
      assert.deepEqual(yield* f.material.windowOptions, { transparent: true });
      yield* f.commit({ appearancePreset: "default" });
      assert.deepEqual(yield* f.material.windowOptions, {});
    }),
  );

  it.effect("Windows keeps Mica regardless of macOS candidate restrictions", () =>
    Effect.gen(function* () {
      const f = yield* select({
        platform: "win32",
        arch: "x64",
      });
      yield* f.material.afterReveal(f.window);
      assert.deepEqual(f.selection.capability, { supported: true, material: "windows-mica" });
      assert.equal((yield* f.material.getState(1)).applied, "windows-mica");
      assert.equal(f.model.material, "mica");
      assert.equal(f.loads(), 0);
      assert.equal(f.model.handleReads, 0);
      f.close();
      assert.equal(f.model.material, "none");
      assert.equal(f.model.backing, "#ffffff");
    }),
  );

  it.effect.each(rejected)("$name rejects without loading or touching a handle", (options) =>
    Effect.gen(function* () {
      const f = yield* select(options);
      yield* f.material.afterReveal(f.window);
      assert.deepEqual(f.selection.capability, {
        supported: false,
        reason:
          "reason" in options
            ? options.reason
            : options.name === "Linux"
              ? "platform"
              : "api-unavailable",
      });
      assert.isNull(f.selection.adapter);
      assert.equal(f.loads(), 0);
      assert.equal(f.prepares(), 0);
      assert.equal(f.state.allocations, 0);
      assert.equal(f.state.mutations, 0);
      assert.equal(f.model.handleReads, 0);
      assert.equal((yield* f.material.getState(1)).reason, "unsupported");
    }),
  );

  it.effect.each(rejected)("$name never evaluates the real ffi-rs import", (options) =>
    Effect.gen(function* () {
      const f = yield* select({ ...options, realLoader: true });
      yield* f.material.afterReveal(f.window);
      assert.equal(imports.ffi, 0);
      assert.equal(f.model.handleReads, 0);
    }),
  );

  it.effect.each([
    { name: "instance ABI mismatch", mismatch: "init" },
    { name: "class ABI mismatch", mismatch: "colorWithSRGBRed:green:blue:alpha:" },
    { name: "missing class method", missingMethod: "alloc" },
    { name: "missing class", missingClass: "NSGlassEffectView" },
    { name: "missing selector", missingSelector: "setTintColor:" },
    { name: "not main thread", mainThread: false },
  ])("$name fails the first attach before window mutation", (native) =>
    Effect.gen(function* () {
      const f = yield* select({ native });
      yield* f.material.afterReveal(f.window);
      assert.equal((yield* f.material.getState(1)).reason, "native-failed");
      assert.equal(f.loads(), 1);
      assert.equal(f.state.allocations, 0);
      assert.equal(f.state.mutations, 0);
      assert.equal(f.model.handleReads, 0);
    }),
  );

  it.effect("supported macOS loads ffi-rs only once the user turns system glass on", () =>
    Effect.gen(function* () {
      const f = yield* select({ enabled: false });
      yield* f.material.afterReveal(f.window);
      assert.deepEqual(f.selection.capability, { supported: true, material: "macos-glass" });
      assert.equal((yield* f.material.getState(1)).reason, "off");
      assert.equal(f.loads(), 0);
      assert.equal(f.model.handleReads, 0);
      yield* f.commit({ desktopSystemMaterialEnabled: true });
      assert.equal((yield* Queue.take(f.states)).reason, "off");
      assert.equal((yield* Queue.take(f.states)).applied, "macos-glass");
      assert.equal(f.loads(), 1);
      assert.equal(f.state.liveViews.size, 1);
      assert.equal(f.model.shadowInvalidations, 1);
    }),
  );

  it.effect("glass turned on in a window created opaque waits for a restart", () =>
    Effect.gen(function* () {
      const f = yield* select({ enabled: false, transparent: false });
      yield* f.material.afterReveal(f.window);
      assert.deepEqual(yield* f.material.windowOptions, {});
      yield* f.commit({ desktopSystemMaterialEnabled: true });
      assert.equal((yield* Queue.take(f.states)).reason, "off");
      assert.equal((yield* Queue.take(f.states)).reason, "restart");
      assert.equal(f.loads(), 0);
      assert.deepEqual(yield* f.material.windowOptions, { transparent: true });
      assert.equal(f.loads(), 1);
      assert.equal(f.model.handleReads, 0);
    }),
  );

  it.effect("a Mac whose AppKit probe fails keeps an opaque window and reports native-failed", () =>
    Effect.gen(function* () {
      const f = yield* select({ transparent: false, native: { mismatch: "init" } });
      assert.deepEqual(yield* f.material.windowOptions, {});
      yield* f.material.afterReveal(f.window);
      assert.equal((yield* f.material.getState(1)).reason, "native-failed");
      assert.equal(f.state.allocations, 0);
      assert.equal(f.model.handleReads, 0);
    }),
  );

  it.effect.each(["off", "fullscreen", "close"] as const)(
    "%s during macOS prepare prevents both attachment and tint updates",
    (interruption) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const f = yield* select({
          prepare: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume))),
        });
        const revealing = yield* f.material.afterReveal(f.window).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        if (interruption === "off") yield* f.commit({ desktopSystemMaterialEnabled: false });
        if (interruption === "fullscreen") f.fullscreen(true);
        if (interruption === "close") {
          f.close();
          f.closed();
        }
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(revealing);
        assert.equal(f.model.handleReads, 0);
        assert.equal(f.state.allocations, 0);
        assert.deepEqual(f.state.tints, []);
      }),
  );

  it.effect(
    "packaged arm64 attaches with initial tint, updates in place, and closes synchronously",
    () =>
      Effect.gen(function* () {
        const f = yield* select();
        yield* f.material.afterReveal(f.window);
        assert.equal((yield* f.material.getState(1)).applied, "macos-glass");
        assert.deepEqual(f.state.tints[0], [0.96, 0.96, 0.97, 0.35 + (0.5 * (80 - 40)) / 60]);
        assert.equal(f.state.liveViews.size, 1);
        yield* f.material.syncAppearance(f.window, true);
        assert.deepEqual(f.state.tints.at(-1), [0.11, 0.11, 0.12, 0.35 + (0.5 * (80 - 40)) / 60]);
        const tints = yield* Queue.unbounded<void>();
        f.state.onTint = () => {
          Queue.offerUnsafe(tints, undefined);
        };
        yield* f.commit({ glassOpacity: 40 });
        yield* Queue.take(tints);
        assert.deepEqual(f.state.tints.at(-1), [0.11, 0.11, 0.12, 0.35]);
        f.theme(false);
        yield* Queue.take(tints);
        assert.deepEqual(f.state.tints.at(-1), [0.96, 0.96, 0.97, 0.35]);
        assert.equal(f.state.allocations, 1);
        yield* f.material.syncAppearance(f.window, true);
        f.close();
        assert.equal(f.model.backing, "#000000");
        assert.equal(f.state.liveViews.size, 0);
        assert.equal(f.state.activeConstraints.size, 0);
        const mutations = f.state.mutations;
        f.closed();
        yield* f.material.syncAppearance(f.window, false);
        yield* f.commit({ glassOpacity: 80 });
        assert.equal(f.state.mutations, mutations);
      }),
  );

  it.effect(
    "tint update failure restores solid backing, publishes native-failed, and releases",
    () =>
      Effect.gen(function* () {
        const f = yield* select();
        yield* f.material.afterReveal(f.window);
        let releaseBacking: string | undefined;
        f.state.onRemove = () => {
          releaseBacking = f.model.backing;
        };
        f.state.fail = "tint";
        yield* f.material.syncAppearance(f.window, true);
        assert.equal((yield* f.material.getState(1)).reason, "native-failed");
        assert.equal(f.model.backing, "#000000");
        assert.equal(f.state.liveViews.size, 0);
        assert.equal(f.state.activeConstraints.size, 0);
        assert.equal(releaseBacking, "#000000");
      }),
  );
});
