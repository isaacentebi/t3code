import type { DesktopBridge } from "@t3tools/contracts";
import type { DesktopWindowMaterialState } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { vi } from "vite-plus/test";
import { __resetClientSettingsPersistenceForTests } from "../src/hooks/useSettings";

export function materialState(
  patch: Partial<DesktopWindowMaterialState> = {},
): DesktopWindowMaterialState {
  return {
    revision: 1,
    capability: { supported: true, material: "windows-mica" },
    enabled: true,
    applied: "windows-mica",
    reducedTransparency: false,
    highContrast: false,
    reason: "active",
    ...patch,
  };
}

export function materialBridge(initial = materialState(), platform = "win32") {
  __resetClientSettingsPersistenceForTests();
  const original = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  const listeners = new Set<(next: DesktopWindowMaterialState) => void>();
  let current = initial;
  let saved: ClientSettings = { ...DEFAULT_CLIENT_SETTINGS, glassOpacity: 80 };
  const bridge = {
    getLocalEnvironmentBootstraps: () => [],
    getClientPlatform: () => platform,
    getClientSettings: vi.fn(async () => saved),
    setClientSettings: vi.fn(async (settings: ClientSettings) => {
      saved = settings;
    }),
    getWindowMaterialState: vi.fn(async () => current),
    relaunchForWindowMaterial: vi.fn(async () => undefined) as (() => Promise<void>) | undefined,
    onWindowMaterialStateChanged: (listener: (next: DesktopWindowMaterialState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    writable: true,
    value: bridge as unknown as DesktopBridge,
  });
  return {
    bridge,
    saved: () => saved,
    push(next: DesktopWindowMaterialState) {
      current = next;
      for (const listener of listeners) listener(next);
    },
    [Symbol.dispose]() {
      if (original) Object.defineProperty(window, "desktopBridge", original);
      else Reflect.deleteProperty(window, "desktopBridge");
      __resetClientSettingsPersistenceForTests();
    },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
