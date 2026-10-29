import * as NodeEvents from "node:events";
import { DEFAULT_CLIENT_SETTINGS, type DesktopWindowMaterialState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type { BrowserWindow } from "electron";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as Adapters from "./adapters.ts";
import * as Material from "./DesktopWindowMaterial.ts";

import * as MaterialPlatform from "./materialPlatform.ts";
export const makeFixture = Effect.fn("test.materialFixture")(function* (
  options: {
    enabled?: boolean | undefined;
    transparent?: boolean | undefined;
    prepare?: Adapters.MaterialAdapter["prepare"];
    failAttach?: boolean;
    failUpdate?: boolean;
    selection?: MaterialPlatform.DesktopMaterialPlatform["Service"];
    platform?: NodeJS.Platform;
    settingsStore?: DesktopClientSettings.DesktopClientSettings["Service"];
  } = {},
) {
  const states = yield* Queue.unbounded<DesktopWindowMaterialState>();
  const settingsStore =
    options.settingsStore ??
    Context.get(
      yield* Layer.build(
        DesktopClientSettings.layerTest(
          Option.some({
            ...DEFAULT_CLIENT_SETTINGS,
            desktopSystemMaterialEnabled: options.enabled ?? true,
          }),
        ),
      ),
      DesktopClientSettings.DesktopClientSettings,
    );
  const native = new NodeEvents.EventEmitter();
  const model = {
    backing: "#ffffff",
    material: "none",
    overlay: {} as unknown,
    live: false,
    destroyed: false,
    fullscreen: false,
    handleReads: 0,
    attaches: 0,
    appearances: [] as Adapters.MaterialAppearance[],
    releases: 0,
    releaseBackings: [] as string[],
    shadowInvalidations: 0,
  };
  const window = Object.assign(native, {
    webContents: {
      id: 1,
      isDestroyed: () => model.destroyed,
      send: (_channel: string, state: DesktopWindowMaterialState) =>
        Queue.offerUnsafe(states, state),
    },
    getNativeWindowHandle: () => {
      model.handleReads++;
      const handle = Buffer.alloc(8);
      handle.writeBigUInt64LE(1n);
      return handle;
    },
    isDestroyed: () => model.destroyed,
    isFullScreen: () => model.fullscreen,
    setBackgroundMaterial: (value: string) => {
      model.material = value;
    },
    setBackgroundColor: (color: string) => {
      model.backing = color;
    },
    setTitleBarOverlay: (overlay: unknown) => {
      model.overlay = overlay;
    },
    invalidateShadow: () => {
      model.shadowInvalidations++;
    },
  }) as unknown as BrowserWindow;
  let dark = false;
  let accessibility = { reducedTransparency: false, highContrast: false };
  let updated = () => {};
  const material = yield* Material.make.pipe(
    Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
      platform: options.platform ?? "win32",
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
    Effect.provideService(DesktopClientSettings.DesktopClientSettings, settingsStore),
    Effect.provideService(ElectronTheme.ElectronTheme, {
      shouldUseDarkColors: Effect.sync(() => dark),
      setSource: () => Effect.void,
      accessibility: Effect.sync(() => accessibility),
      onUpdated: (listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            updated = listener;
          }),
          () =>
            Effect.sync(() => {
              updated = () => {};
            }),
        ),
    }),
    Effect.provideService(
      MaterialPlatform.DesktopMaterialPlatform,
      options.selection ?? {
        capability: { supported: true, material: "windows-mica" },
        adapter: {
          kind: "windows-mica",
          prepare: options.prepare ?? (() => Effect.void),
          attachSync: (_window, appearance) => {
            if (options.failAttach) throw new Error("native attachment failed");
            model.appearances.push(appearance);
            model.attaches++;
            model.live = true;
            let released = false;
            return {
              updateSync: (next) => {
                if (released) throw new Error("update after release");
                if (options.failUpdate) throw new Error("update failed");
                model.appearances.push(next);
              },
              releaseSync: () => {
                if (released) return;
                model.releaseBackings.push(model.backing);
                model.releases++;
                model.live = false;
                released = true;
              },
            };
          },
        },
      },
    ),
  );
  yield* material.attach(window, { transparent: options.transparent ?? true });
  return {
    material,
    window,
    model,
    states,
    settingsStore,
    commit: Effect.fn("test.materialFixture.commit")(function* (
      patch: Partial<typeof DEFAULT_CLIENT_SETTINGS>,
    ) {
      const current = yield* settingsStore.get;
      yield* settingsStore.set({
        ...DEFAULT_CLIENT_SETTINGS,
        ...Option.getOrUndefined(current),
        ...patch,
      });
    }),
    fullscreen: (value: boolean) => {
      model.fullscreen = value;
      native.emit(value ? "enter-full-screen" : "leave-full-screen");
    },
    close: (cancel = false) => native.emit("close", { defaultPrevented: cancel }),
    closed: () => {
      model.destroyed = true;
      native.emit("closed");
    },
    theme: (value: boolean) => {
      dark = value;
      updated();
    },
    accessibility: (value: typeof accessibility) => {
      accessibility = value;
      updated();
    },
  };
});
