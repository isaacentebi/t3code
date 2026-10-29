import { useEffect } from "react";
import { useDesktopWindowMaterial } from "../desktop/useDesktopWindowMaterial";
import { useClientSettings } from "../hooks/useSettings";
import { drawCodeTerrain } from "./codeTerrain";
import { loadCustomBackdrop, subscribeCustomBackdrop } from "./glassBackdropStore";

function asBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.88));
}

async function buildBackdrop(useCustom: boolean): Promise<Blob | null> {
  const ratio = Math.min(window.devicePixelRatio || 1, 1);
  const width = Math.max(1, Math.round(window.innerWidth * ratio));
  const height = Math.max(1, Math.round(window.innerHeight * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const custom = useCustom ? await loadCustomBackdrop().catch(() => null) : null;
  if (custom) {
    try {
      const bitmap = await createImageBitmap(custom);
      try {
        const scale = Math.max((width + 48) / bitmap.width, (height + 48) / bitmap.height);
        const drawWidth = bitmap.width * scale;
        const drawHeight = bitmap.height * scale;
        context.filter = "blur(24px) saturate(1.2)";
        context.drawImage(
          bitmap,
          (width - drawWidth) / 2,
          (height - drawHeight) / 2,
          drawWidth,
          drawHeight,
        );
        context.filter = "none";
        return asBlob(canvas);
      } finally {
        bitmap.close();
      }
    } catch {
      // A missing or unreadable local image uses the built-in terrain.
    }
  }
  const terrain = document.createElement("canvas");
  terrain.width = width;
  terrain.height = height;
  const terrainContext = terrain.getContext("2d");
  if (!terrainContext) return null;
  drawCodeTerrain(terrainContext, {
    width,
    height,
    dark: document.documentElement.classList.contains("dark"),
  });
  // Soft enough that glyphs read as texture, never as text competing with the transcript.
  context.filter = "blur(1.1px)";
  context.drawImage(terrain, 0, 0);
  context.filter = "none";
  return asBlob(canvas);
}

export function LiquidGlassBackdrop() {
  const appearancePreset = useClientSettings((settings) => settings.appearancePreset);
  const glassBackdrop = useClientSettings((settings) => settings.glassBackdrop);
  const { state } = useDesktopWindowMaterial();
  const nativeMaterial = state?.applied === "macos-glass" || state?.applied === "windows-mica";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The canvas URL and viewport observers synchronize with browser state.
  useEffect(() => {
    const root = document.documentElement;
    if (appearancePreset !== "liquid-glass" || nativeMaterial) {
      root.style.removeProperty("--lg-backdrop");
      return;
    }
    let active = true;
    // A mutable box keeps the request counter React Compiler-friendly inside the closures.
    const generation = { current: 0 };
    let currentUrl: string | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const rebuild = () => {
      generation.current += 1;
      const requested = generation.current;
      void buildBackdrop(glassBackdrop === "custom").then((blob) => {
        if (!blob || !active || requested !== generation.current) return;
        const url = URL.createObjectURL(blob);
        root.style.setProperty("--lg-backdrop", `url("${url}")`);
        if (currentUrl) URL.revokeObjectURL(currentUrl);
        currentUrl = url;
      });
    };
    const observer = new MutationObserver(rebuild);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(rebuild, 250);
    };
    window.addEventListener("resize", onResize);
    const unsubscribe = subscribeCustomBackdrop(rebuild);
    rebuild();
    return () => {
      active = false;
      generation.current += 1;
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      if (resizeTimer) clearTimeout(resizeTimer);
      unsubscribe();
      root.style.removeProperty("--lg-backdrop");
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [appearancePreset, glassBackdrop, nativeMaterial]);

  return null;
}
