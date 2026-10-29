import { DesktopWindowMaterialState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

// The sandboxed preload forwards material state undecoded.
const decodeWindowMaterialState = Schema.decodeUnknownOption(DesktopWindowMaterialState);

// Older desktop builds lack the material bridge; their clients keep the CSS-only settings.
export function hasDesktopWindowMaterialApi(): boolean {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  return Boolean(bridge?.getWindowMaterialState && bridge.onWindowMaterialStateChanged);
}

export function useDesktopWindowMaterial() {
  const bridge = window.desktopBridge;
  const available = hasDesktopWindowMaterialApi();
  const [state, setState] = useState<DesktopWindowMaterialState | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to material state pushed by the desktop main process
  useEffect(() => {
    if (!bridge?.getWindowMaterialState || !bridge.onWindowMaterialStateChanged) return;
    let disposed = false;
    const accept = (value: unknown) => {
      const decoded = decodeWindowMaterialState(value);
      if (disposed || Option.isNone(decoded)) return;
      const next = decoded.value;
      setState((current) => (current && current.revision >= next.revision ? current : next));
    };
    // Pushes can overtake the initial IPC response.
    const unsubscribe = bridge.onWindowMaterialStateChanged(accept);
    void bridge.getWindowMaterialState().then(accept, (error: unknown) => {
      if (!disposed) console.error("Could not read desktop window material.", error);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge]);

  return { available, state };
}
