import type { DesktopWindowMaterialState } from "@t3tools/contracts";
import { useState } from "react";
import { useDesktopWindowMaterial } from "../../desktop/useDesktopWindowMaterial";
import {
  canRelaunchForWindowMaterial,
  WindowMaterialRestartDialog,
} from "../../desktop/WindowMaterialRestartPrompt";
import { useClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function materialStatus(state: DesktopWindowMaterialState | null): string {
  if (!state) return "Checking system glass availability…";
  if (!state.capability.supported) {
    const platform = window.desktopBridge?.getClientPlatform?.() ?? navigator.platform;
    if (/darwin|mac/i.test(platform)) {
      return state.capability.reason === "os-version"
        ? "Requires macOS 26 or later."
        : "System glass is not available on this Mac.";
    }
    if (state.capability.reason === "os-version") return "Requires Windows 11 22H2 or later.";
    return "System glass is not available on this device.";
  }
  switch (state.reason) {
    case "accessibility":
      return "Off while reduced transparency or high contrast is on.";
    case "opaque":
      return "Off at 100% glass opacity.";
    case "fullscreen":
      return "Paused in full screen.";
    case "native-failed":
      return "The system material could not be applied.";
    case "restart":
      return "Restart T3 Code to use Liquid Glass.";
    case "active":
      return state.applied === "windows-mica" ? "Using Mica." : "Using Liquid Glass.";
    default:
      return "Use the system material in the sidebar and title bar.";
  }
}

export function DesktopWindowMaterialSetting() {
  const { available, state } = useDesktopWindowMaterial();
  const enabled = useScopedSettings((settings) => settings.desktopSystemMaterialEnabled);
  const appearancePreset = useClientSettings((settings) => settings.appearancePreset);
  const updateSettings = useUpdateScopedSettings();
  const [restartOpen, setRestartOpen] = useState(false);
  if (!available) return null;
  const presetForcesMaterial = appearancePreset === "liquid-glass";
  const statusTakesPriority =
    !state ||
    !state.capability.supported ||
    state.reason === "unsupported" ||
    state.reason === "restart" ||
    state.reason === "accessibility" ||
    state.reason === "opaque" ||
    state.reason === "native-failed" ||
    state.reason === "fullscreen";
  const canRestart = state?.reason === "restart" && canRelaunchForWindowMaterial();

  return (
    <>
      <SettingsRow
        {...searchableSetting("desktop-system-material")}
        description={
          presetForcesMaterial && !statusTakesPriority
            ? "On while the Liquid Glass style is selected."
            : materialStatus(state)
        }
        control={
          <div className="flex items-center gap-2">
            {canRestart ? (
              <Button size="xs" variant="outline" onClick={() => setRestartOpen(true)}>
                Restart
              </Button>
            ) : null}
            <Switch
              aria-label="System glass"
              checked={enabled || presetForcesMaterial}
              disabled={presetForcesMaterial || !state?.capability.supported}
              onCheckedChange={(checked) =>
                updateSettings({ desktopSystemMaterialEnabled: Boolean(checked) })
              }
            />
          </div>
        }
      />
      {canRestart ? (
        <WindowMaterialRestartDialog open={restartOpen} onOpenChange={setRestartOpen} />
      ) : null}
    </>
  );
}
