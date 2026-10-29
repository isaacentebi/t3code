import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";
import { deferred, materialBridge, materialState } from "../../test/windowMaterial";
import { ensureClientSettingsHydrated, persistClientSettingsPatch } from "../hooks/useSettings";
import { DesktopWindowMaterialSync } from "./DesktopWindowMaterialSync";
import "../index.css";

const macGlass = (
  reason: "off" | "opaque" | "restart" | "unrevealed" | "accessibility",
  revision: number,
) =>
  materialState({
    revision,
    capability: { supported: true, material: "macos-glass" },
    applied: "none",
    reason,
  });

it("keeps the newest pushed revision when the initial read arrives late and cleans up", async () => {
  using fixture = materialBridge();
  const read = deferred<ReturnType<typeof materialState>>();
  fixture.bridge.getWindowMaterialState.mockReturnValueOnce(read.promise);
  await using screen = await render(<DesktopWindowMaterialSync />);
  await act(() =>
    fixture.push(materialState({ revision: 3, applied: "none", highContrast: true })),
  );
  await act(async () => {
    read.resolve(materialState({ revision: 1 }));
    await read.promise;
  });
  await act(() => fixture.push(materialState({ revision: 2 })));
  expect(document.documentElement.dataset.desktopWindowMaterial).toBe("none");
  expect(document.documentElement.dataset.desktopGlassOpaque).toBe("accessibility");
  await screen.unmount();
  expect(document.documentElement.hasAttribute("data-desktop-client")).toBe(false);
  expect(document.documentElement.hasAttribute("data-desktop-window-material")).toBe(false);
  expect(document.documentElement.hasAttribute("data-desktop-glass-opaque")).toBe(false);
});

it("rehydrates on remount and rejects a stale event after the fresh read", async () => {
  using fixture = materialBridge();
  await using screen = await render(<DesktopWindowMaterialSync />);
  await act(() =>
    fixture.push(materialState({ revision: 4, applied: "none", reason: "fullscreen" })),
  );
  await screen.rerender(<></>);
  fixture.bridge.getWindowMaterialState.mockResolvedValue(materialState({ revision: 5 }));
  await screen.rerender(<DesktopWindowMaterialSync />);
  await act(() =>
    fixture.push(materialState({ revision: 4, applied: "none", reason: "fullscreen" })),
  );
  expect(document.documentElement.dataset.desktopWindowMaterial).toBe("windows-mica");
  await act(() => persistClientSettingsPatch({ glassOpacity: 100 }));
  expect(document.documentElement.dataset.desktopGlassOpaque).toBe("opacity");
  await act(() => persistClientSettingsPatch({ glassOpacity: 80 }));
  expect(document.documentElement.hasAttribute("data-desktop-glass-opaque")).toBe(false);
});

it("asks to restart when glass turned on here needs a new window, and Restart now relaunches", async () => {
  using fixture = materialBridge(macGlass("off", 1), "darwin");
  const read = deferred<ReturnType<typeof materialState>>();
  fixture.bridge.getWindowMaterialState.mockReturnValueOnce(read.promise);
  await ensureClientSettingsHydrated();
  await using screen = await render(<DesktopWindowMaterialSync />);
  // The change and its push land before the first state read answers.
  await act(() => persistClientSettingsPatch({ desktopSystemMaterialEnabled: true }));
  await act(() => fixture.push(macGlass("restart", 2)));
  await expect.element(screen.getByRole("alertdialog")).toBeVisible();
  await act(async () => {
    read.resolve(macGlass("off", 1));
    await read.promise;
  });
  await screen.getByRole("button", { name: "Restart now" }).click();
  expect(fixture.bridge.relaunchForWindowMaterial).toHaveBeenCalledTimes(1);
});

it("keeps the dialog open with an error when the relaunch request fails", async () => {
  using fixture = materialBridge(macGlass("opaque", 1), "darwin");
  fixture.bridge.relaunchForWindowMaterial = vi.fn(async () => {
    throw new Error("ipc closed");
  });
  await ensureClientSettingsHydrated();
  await using screen = await render(<DesktopWindowMaterialSync />);
  await act(() =>
    persistClientSettingsPatch({ desktopSystemMaterialEnabled: true, glassOpacity: 100 }),
  );
  await act(() => persistClientSettingsPatch({ glassOpacity: 90 }));
  await act(() => fixture.push(macGlass("restart", 2)));
  await screen.getByRole("button", { name: "Restart now" }).click();
  await expect
    .element(screen.getByText("Couldn't restart T3 Code. Quit and reopen it to use Liquid Glass."))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Restart now" })).toBeEnabled();
});

it("asks once per change: Later stays quiet until glass is turned on again", async () => {
  using fixture = materialBridge(macGlass("off", 1), "darwin");
  await ensureClientSettingsHydrated();
  await using screen = await render(<DesktopWindowMaterialSync />);
  await act(() => persistClientSettingsPatch({ appearancePreset: "liquid-glass" }));
  await act(() => fixture.push(macGlass("restart", 2)));
  await screen.getByRole("button", { name: "Later" }).click();
  await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
  await act(() => fixture.push(macGlass("accessibility", 3)));
  await act(() => fixture.push(macGlass("restart", 4)));
  await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
  await act(() => persistClientSettingsPatch({ appearancePreset: "default" }));
  await act(() => fixture.push(macGlass("off", 5)));
  await act(() => persistClientSettingsPatch({ appearancePreset: "liquid-glass" }));
  await act(() => fixture.push(macGlass("restart", 6)));
  await expect.element(screen.getByRole("alertdialog")).toBeVisible();
  expect(fixture.bridge.relaunchForWindowMaterial).not.toHaveBeenCalled();
});

it("waits for reduced transparency to end before asking about a glass change made here", async () => {
  using fixture = materialBridge(macGlass("off", 1), "darwin");
  await ensureClientSettingsHydrated();
  await using screen = await render(<DesktopWindowMaterialSync />);
  await act(() => persistClientSettingsPatch({ desktopSystemMaterialEnabled: true }));
  await act(() => fixture.push(macGlass("accessibility", 2)));
  await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
  await act(() => fixture.push(macGlass("restart", 3)));
  await expect.element(screen.getByRole("alertdialog")).toBeVisible();
});

it("does not ask without a change made here, or when the app cannot relaunch", async () => {
  using fixture = materialBridge(macGlass("unrevealed", 1), "darwin");
  await fixture.bridge.setClientSettings({
    ...fixture.saved(),
    desktopSystemMaterialEnabled: true,
  });
  await ensureClientSettingsHydrated();
  await using screen = await render(<DesktopWindowMaterialSync />);
  await act(() => fixture.push(macGlass("restart", 2)));
  await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
  await act(() => persistClientSettingsPatch({ desktopSystemMaterialEnabled: false }));
  await act(() => fixture.push(macGlass("off", 3)));
  await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
  await screen.rerender(<></>);
  fixture.bridge.relaunchForWindowMaterial = undefined;
  await screen.rerender(<DesktopWindowMaterialSync />);
  await act(() => persistClientSettingsPatch({ desktopSystemMaterialEnabled: true }));
  await act(() => fixture.push(macGlass("restart", 4)));
  await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
});

it("does not ask again when turning glass off after Later fails to save and rolls back", async () => {
  using fixture = materialBridge(macGlass("off", 1), "darwin");
  await ensureClientSettingsHydrated();
  await using screen = await render(<DesktopWindowMaterialSync />);
  await act(() => persistClientSettingsPatch({ desktopSystemMaterialEnabled: true }));
  await act(() => fixture.push(macGlass("restart", 2)));
  await screen.getByRole("button", { name: "Later" }).click();
  await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
  fixture.bridge.setClientSettings.mockRejectedValueOnce(new Error("disk unavailable"));
  using _log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await act(() =>
    persistClientSettingsPatch({ desktopSystemMaterialEnabled: false }).catch(() => undefined),
  );
  expect(fixture.saved().desktopSystemMaterialEnabled).toBe(true);
  await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
});

it("asks again when glass is turned off and back on before the desktop reports off", async () => {
  using fixture = materialBridge(macGlass("off", 1), "darwin");
  await ensureClientSettingsHydrated();
  await using screen = await render(<DesktopWindowMaterialSync />);
  await act(() => persistClientSettingsPatch({ desktopSystemMaterialEnabled: true }));
  await act(() => fixture.push(macGlass("restart", 2)));
  await screen.getByRole("button", { name: "Later" }).click();
  await act(() => persistClientSettingsPatch({ desktopSystemMaterialEnabled: false }));
  await act(() => persistClientSettingsPatch({ desktopSystemMaterialEnabled: true }));
  await expect.element(screen.getByRole("alertdialog")).toBeVisible();
});

it("does not ask after Later when reduced transparency passes and a failed off rolls back", async () => {
  using fixture = materialBridge(macGlass("off", 1), "darwin");
  await ensureClientSettingsHydrated();
  await using screen = await render(<DesktopWindowMaterialSync />);
  await act(() => persistClientSettingsPatch({ desktopSystemMaterialEnabled: true }));
  await act(() => fixture.push(macGlass("restart", 2)));
  await screen.getByRole("button", { name: "Later" }).click();
  await act(() => fixture.push(macGlass("accessibility", 3)));
  fixture.bridge.setClientSettings.mockRejectedValueOnce(new Error("disk unavailable"));
  using _log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await act(() =>
    persistClientSettingsPatch({ desktopSystemMaterialEnabled: false }).catch(() => undefined),
  );
  await act(() => fixture.push(macGlass("restart", 4)));
  await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
});

it("asks for a glass change saved before the prompt mounted", async () => {
  using fixture = materialBridge(macGlass("off", 1), "darwin");
  await ensureClientSettingsHydrated();
  await persistClientSettingsPatch({ desktopSystemMaterialEnabled: true });
  fixture.bridge.getWindowMaterialState.mockResolvedValue(macGlass("restart", 2));
  await using screen = await render(<DesktopWindowMaterialSync />);
  await expect.element(screen.getByRole("alertdialog")).toBeVisible();
});

it("does not ask when glass was turned back off before the turn-on finished saving", async () => {
  using fixture = materialBridge(macGlass("off", 1), "darwin");
  await ensureClientSettingsHydrated();
  await using screen = await render(<DesktopWindowMaterialSync />);
  const write = deferred<void>();
  fixture.bridge.setClientSettings.mockReturnValueOnce(write.promise);
  let on: Promise<void> = Promise.resolve();
  let off: Promise<void> = Promise.resolve();
  await act(() => {
    on = persistClientSettingsPatch({ desktopSystemMaterialEnabled: true });
  });
  // Turn it off while the turn-on is already being written.
  await vi.waitFor(() => expect(fixture.bridge.setClientSettings).toHaveBeenCalled());
  await act(() => {
    off = persistClientSettingsPatch({ desktopSystemMaterialEnabled: false });
  });
  await act(async () => {
    write.resolve();
    await on;
  });
  await act(() => fixture.push(macGlass("restart", 2)));
  await act(() => off);
  await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
});
