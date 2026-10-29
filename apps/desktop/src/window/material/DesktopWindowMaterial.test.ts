import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";
import * as Adapters from "./adapters.ts";
import * as Material from "./DesktopWindowMaterial.ts";
import { makeFixture } from "./materialTestFixture.ts";

vi.mock("node:os", () => ({ release: () => "10.0.22621" }));
vi.mock("electron", () => ({
  BrowserWindow: class {
    setBackgroundMaterial() {}
  },
}));

describe("DesktopWindowMaterial", () => {
  it.effect(
    "Liquid Glass activates material with the switch off and Default turns it off again",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ enabled: false });
        yield* f.material.afterReveal(f.window);
        assert.equal((yield* Queue.take(f.states)).reason, "off");
        yield* f.commit({ appearancePreset: "liquid-glass" });
        const active = yield* Queue.take(f.states);
        assert.equal(active.reason, "active");
        assert.isTrue(active.enabled);
        assert.isTrue(f.model.live);
        yield* f.commit({ appearancePreset: "default" });
        const off = yield* Queue.take(f.states);
        assert.equal(off.reason, "off");
        assert.isFalse(off.enabled);
        assert.isFalse(f.model.live);
        assert.isFalse(Option.getOrThrow(yield* f.settingsStore.get).desktopSystemMaterialEnabled);
      }),
  );

  it.effect("leaving Liquid Glass keeps material active when the switch is on", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ enabled: true });
      yield* f.material.afterReveal(f.window);
      yield* Queue.take(f.states);
      yield* f.commit({ appearancePreset: "liquid-glass" });
      yield* f.commit({ appearancePreset: "default" });
      const state = yield* f.material.getState(1);
      assert.equal(state.reason, "active");
      assert.isTrue(state.enabled);
      assert.isTrue(f.model.live);
      assert.equal(f.model.releases, 0);
    }),
  );

  it.effect("applies after reveal, toggles once, and restores solid backing before release", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      assert.isFalse(f.model.live);
      assert.equal((yield* f.material.getState(1)).reason, "unrevealed");
      yield* f.material.afterReveal(f.window);
      const active = yield* Queue.take(f.states);
      assert.equal(active.reason, "active");
      assert.isTrue(f.model.live);
      assert.equal(f.model.backing, "#00000000");
      assert.propertyVal(f.model.overlay, "color", "#00000000");
      yield* f.commit({ desktopSystemMaterialEnabled: false });
      const off = yield* Queue.take(f.states);
      assert.equal(off.reason, "off");
      assert.isAbove(off.revision, active.revision);
      assert.isFalse(f.model.live);
      assert.deepEqual(f.model.releaseBackings, ["#ffffff"]);
      yield* f.commit({ desktopSystemMaterialEnabled: true });
      assert.equal((yield* Queue.take(f.states)).reason, "active");
      yield* f.commit({ fontSizeCode: 14 });
      assert.equal(f.model.attaches, 2);
      assert.equal(f.model.releases, 1);
      assert.isTrue(f.model.live);
    }),
  );

  it.effect("fullscreen suspends material and leaving fullscreen restores it", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.material.afterReveal(f.window);
      yield* Queue.take(f.states);
      f.fullscreen(true);
      assert.isFalse(f.model.live);
      assert.equal((yield* Queue.take(f.states)).reason, "fullscreen");
      f.fullscreen(false);
      assert.equal((yield* Queue.take(f.states)).reason, "active");
      assert.isTrue(f.model.live);
      assert.equal(f.model.releases, 1);
    }),
  );

  it.effect("close releases synchronously once and closed drops the sender and later events", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.material.afterReveal(f.window);
      yield* Queue.take(f.states);
      f.close();
      assert.isFalse(f.model.live);
      assert.equal(f.model.releases, 1);
      f.closed();
      yield* f.commit({ desktopSystemMaterialEnabled: false });
      f.fullscreen(false);
      const error = yield* f.material.getState(1).pipe(Effect.flip);
      assert.instanceOf(error, Material.WindowMaterialSenderError);
      assert.equal(f.model.releases, 1);
    }),
  );

  it.effect("cancelled close reacquires after close dispatch", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.material.afterReveal(f.window);
      yield* Queue.take(f.states);
      f.close(true);
      assert.isFalse(f.model.live);
      assert.equal((yield* Queue.take(f.states)).reason, "unrevealed");
      assert.equal((yield* Queue.take(f.states)).reason, "active");
      assert.isTrue(f.model.live);
      assert.equal(f.model.attaches, 2);
    }),
  );

  it.effect.each(["prepare", "attach"] as const)(
    "%s failure publishes native-failed with solid backing",
    (failure) =>
      Effect.gen(function* () {
        const f = yield* makeFixture(
          failure === "prepare"
            ? {
                prepare: () =>
                  Effect.fail(
                    new Adapters.NativeMaterialError({ cause: new Error("prepare failed") }),
                  ),
              }
            : { failAttach: true },
        );
        yield* f.material.afterReveal(f.window);
        assert.equal((yield* Queue.take(f.states)).reason, "native-failed");
        assert.equal(f.model.backing, "#ffffff");
        assert.isFalse(f.model.live);
      }),
  );

  it.effect.each(["off", "close", "fullscreen"] as const)(
    "%s during prepare prevents late attachment",
    (interruption) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const f = yield* makeFixture({
          prepare: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume))),
        });
        const reveal = yield* f.material.afterReveal(f.window).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        if (interruption === "off") yield* f.commit({ desktopSystemMaterialEnabled: false });
        if (interruption === "close") {
          f.close();
          f.closed();
        }
        if (interruption === "fullscreen") f.fullscreen(true);
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(reveal);
        assert.equal(f.model.attaches, 0);
        assert.deepEqual(f.model.appearances, []);
        assert.isFalse(f.model.live);
        assert.equal(f.model.backing, "#ffffff");
      }),
  );

  it.effect("a newer committed preference wins over a stale startup read", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let listener = (_settings: typeof DEFAULT_CLIENT_SETTINGS) => {};
      const stale = { ...DEFAULT_CLIENT_SETTINGS, desktopSystemMaterialEnabled: false };
      const constructing = yield* makeFixture({
        settingsStore: {
          get: Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.as(Option.some(stale)),
          ),
          set: (settings) => Effect.sync(() => listener(settings)),
          onCommitted: (callback) =>
            Effect.sync(() => {
              listener = callback;
            }),
        },
      }).pipe(Effect.forkChild);
      yield* Deferred.await(reading);
      listener({ ...stale, desktopSystemMaterialEnabled: true });
      yield* Deferred.succeed(resume, undefined);
      const f = yield* Fiber.join(constructing);
      yield* f.material.afterReveal(f.window);
      assert.equal((yield* f.material.getState(1)).reason, "active");
      assert.isTrue(f.model.live);
    }),
  );

  it.effect(
    "theme appearance keeps an active backing clear and caption symbols follow the theme",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.material.afterReveal(f.window);
        yield* f.material.syncAppearance(f.window, true);
        assert.equal(f.model.backing, "#00000000");
        assert.propertyVal(f.model.overlay, "color", "#00000000");
        assert.propertyVal(f.model.overlay, "symbolColor", "#f8fafc");
      }),
  );

  it.effect(
    "opacity 100 releases material and accessibility updates restore the solid fallback",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.material.afterReveal(f.window);
        yield* Queue.take(f.states);
        yield* f.commit({ glassOpacity: 100 });
        assert.equal((yield* Queue.take(f.states)).reason, "opaque");
        assert.isFalse(f.model.live);
        yield* f.commit({ glassOpacity: 80 });
        yield* Queue.take(f.states);
        f.accessibility({ reducedTransparency: true, highContrast: false });
        assert.equal((yield* Queue.take(f.states)).reason, "accessibility");
        assert.isFalse(f.model.live);
        assert.equal(f.model.backing, "#ffffff");
        f.accessibility({ reducedTransparency: false, highContrast: true });
        assert.isTrue((yield* Queue.take(f.states)).highContrast);
        f.accessibility({ reducedTransparency: false, highContrast: false });
        assert.equal((yield* Queue.take(f.states)).reason, "active");
        assert.isTrue(f.model.live);
      }),
  );
});
