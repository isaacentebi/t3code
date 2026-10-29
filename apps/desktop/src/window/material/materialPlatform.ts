import * as NodeOS from "node:os";
import type { DesktopWindowMaterialCapability } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as MacosObjcRuntime from "../../electron/MacosObjcRuntime.ts";
import * as Adapters from "./adapters.ts";
import { probeMacosGlass } from "./macosGlassAdapter.ts";
import { probeCapability } from "./materialPolicy.ts";

export class MacosVersion extends Context.Service<
  MacosVersion,
  { readonly get: Effect.Effect<string | null> }
>()("@t3tools/desktop/window/material/materialPlatform/MacosVersion") {}

export const layerMacosVersion = Layer.succeed(MacosVersion, {
  get: Effect.sync(() => {
    try {
      return process.getSystemVersion();
    } catch {
      return null;
    }
  }),
});

export class DesktopMaterialPlatform extends Context.Service<
  DesktopMaterialPlatform,
  {
    readonly capability: DesktopWindowMaterialCapability;
    readonly adapter: Adapters.MaterialAdapter | null;
  }
>()("@t3tools/desktop/window/material/materialPlatform/DesktopMaterialPlatform") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const unavailable = (reason: "api-unavailable" | "os-version" = "api-unavailable") => ({
    capability: { supported: false, reason } as const,
    adapter: null,
  });
  if (environment.platform !== "darwin") {
    const capability = probeCapability({
      platform: environment.platform,
      macOSMajor: null,
      windowsBuild: Number(NodeOS.release().split(".")[2]) || null,
      hasBackgroundMaterialApi:
        typeof Electron.BrowserWindow?.prototype?.setBackgroundMaterial === "function",
    });
    const adapter = yield* Adapters.WindowMaterialAdapter;
    return { capability, adapter: capability.supported ? adapter : null };
  }
  // The AppKit ABI table is recorded for arm64 only.
  if (environment.processArch !== "arm64") return unavailable();
  const version = yield* (yield* MacosVersion).get;
  if (version === null || !/^\d+(?:\.\d+)*$/.test(version)) return unavailable();
  const major = Number(version.split(".")[0]);
  if (!Number.isSafeInteger(major)) return unavailable();
  if (major < 26) return unavailable("os-version");
  const loader = yield* MacosObjcRuntime.MacosObjcRuntime;
  // System glass is opt-in, so ffi-rs loads into main only while it is on.
  // The probe is deterministic per process; a failure stays cached and reports native-failed.
  let probed: Adapters.MaterialAdapter | undefined;
  const probe = yield* Effect.cached(
    loader.load.pipe(
      Effect.flatMap((runtime) =>
        Effect.try({
          try: () => probeMacosGlass(runtime),
          catch: (cause) => new Adapters.NativeMaterialError({ cause }),
        }),
      ),
      Effect.map((adapter) => (probed = adapter)),
    ),
  );
  const adapter: Adapters.MaterialAdapter = {
    kind: "macos-glass",
    prepare: () => probe.pipe(Effect.flatMap((ready) => ready.prepare())),
    attachSync: (window, context) => {
      if (probed === undefined) throw new Error("macOS glass was attached before it was prepared.");
      return probed.attachSync(window, context);
    },
  };
  return { capability: { supported: true, material: "macos-glass" } as const, adapter };
});

export const layer = Layer.effect(DesktopMaterialPlatform, make);
