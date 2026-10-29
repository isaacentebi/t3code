import { useEffect } from "react";
import { useClientSettings } from "../hooks/useSettings";
import { useDesktopWindowMaterial } from "./useDesktopWindowMaterial";
import {
  canRelaunchForWindowMaterial,
  WindowMaterialRestartPrompt,
} from "./WindowMaterialRestartPrompt";

export function DesktopWindowMaterialSync() {
  const { available, state } = useDesktopWindowMaterial();
  const glassOpacity = useClientSettings((settings) => settings.glassOpacity);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the applied window material onto the document root for CSS
  useEffect(() => {
    if (!available) return;
    const root = document.documentElement;
    const properties = ["--glass-opacity", "--glass-blur", "--glass-saturation"];
    const previous = properties.map((name) => [name, root.style.getPropertyValue(name)] as const);
    root.setAttribute("data-desktop-client", "");
    root.setAttribute("data-desktop-window-material", state?.applied ?? "none");
    if (state?.reducedTransparency || state?.highContrast) {
      root.setAttribute("data-desktop-glass-opaque", "accessibility");
    } else if (glassOpacity === 100) {
      root.setAttribute("data-desktop-glass-opaque", "opacity");
    } else {
      root.removeAttribute("data-desktop-glass-opaque");
    }
    // The composer reads these variables directly, including inline opacity from GlassAppearanceSync.
    const opaque = root.hasAttribute("data-desktop-glass-opaque");
    root.style.setProperty("--glass-opacity", opaque ? "100%" : `${glassOpacity}%`);
    if (opaque) {
      root.style.setProperty("--glass-blur", "0px");
      root.style.setProperty("--glass-saturation", "1");
    } else {
      root.style.removeProperty("--glass-blur");
    }
    return () => {
      for (const [name, value] of previous) {
        if (value) root.style.setProperty(name, value);
        else root.style.removeProperty(name);
      }
      root.removeAttribute("data-desktop-client");
      root.removeAttribute("data-desktop-window-material");
      root.removeAttribute("data-desktop-glass-opaque");
    };
  }, [available, state, glassOpacity]);

  if (!available || !canRelaunchForWindowMaterial()) return null;
  return <WindowMaterialRestartPrompt reason={state?.reason ?? null} />;
}
