import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { act, render, stubGlobal } from "../../test/render";
import { materialBridge, materialState } from "../../test/windowMaterial";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  persistClientSettingsPatch,
} from "../hooks/useSettings";
import "../index.css";
import { LiquidGlassBackdrop } from "./LiquidGlassBackdrop";

function glassSettings() {
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, appearancePreset: "liquid-glass" });
  document.documentElement.dataset.appearancePreset = "liquid-glass";
  return {
    [Symbol.dispose]() {
      document.documentElement.removeAttribute("data-appearance-preset");
      __resetClientSettingsPersistenceForTests();
    },
  };
}

it("paints a blob backdrop behind glass and removes it when Default is selected", async () => {
  using _bridge = stubGlobal("desktopBridge", undefined);
  using _settings = glassSettings();
  await using screen = await render(
    <>
      <LiquidGlassBackdrop />
      <div data-glass-pane="pane" className="bg-background" />
    </>,
  );
  await vi.waitFor(() => {
    expect(document.documentElement.style.getPropertyValue("--lg-backdrop")).toContain("blob:");
    expect(getComputedStyle(document.documentElement).backgroundImage).toContain("blob:");
  });
  const url = document.documentElement.style
    .getPropertyValue("--lg-backdrop")
    .match(/blob:[^")]+/)?.[0];
  if (!url) throw new Error("Backdrop URL missing");
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.drawImage(bitmap, -Math.floor(bitmap.width / 2), -Math.floor(bitmap.height / 2));
    const backdropPixel = [...context.getImageData(0, 0, 1, 1).data];
    const pane = screen.container.querySelector('[data-glass-pane="pane"]');
    if (!pane) throw new Error("Glass pane missing");
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = getComputedStyle(pane).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    expect(backdropPixel).not.toEqual([...context.getImageData(0, 0, 1, 1).data]);
  } finally {
    bitmap.close();
  }
  await act(() => persistClientSettingsPatch({ appearancePreset: "default" }, async () => {}));
  await vi.waitFor(() => {
    expect(document.documentElement.style.getPropertyValue("--lg-backdrop")).toBe("");
  });
  await screen.unmount();
});

it("removes the web backdrop when native window material becomes applied", async () => {
  using bridge = materialBridge(materialState({ applied: "none" }));
  using _settings = glassSettings();
  await using screen = await render(<LiquidGlassBackdrop />);
  await vi.waitFor(() => {
    expect(document.documentElement.style.getPropertyValue("--lg-backdrop")).toContain("blob:");
  });
  await act(() => bridge.push(materialState({ revision: 2, applied: "macos-glass" })));
  await vi.waitFor(() => {
    expect(document.documentElement.style.getPropertyValue("--lg-backdrop")).toBe("");
  });
  await screen.unmount();
});
