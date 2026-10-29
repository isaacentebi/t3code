import type {
  DesktopWindowMaterialCapability,
  DesktopWindowMaterialKind,
  DesktopWindowMaterialReason,
} from "@t3tools/contracts";

export function probeCapability(input: {
  readonly platform: NodeJS.Platform;
  readonly macOSMajor: number | null;
  readonly windowsBuild: number | null;
  readonly hasBackgroundMaterialApi: boolean;
}): DesktopWindowMaterialCapability {
  if (input.platform === "darwin") return { supported: false, reason: "api-unavailable" };
  if (input.platform !== "win32") return { supported: false, reason: "platform" };
  if (input.windowsBuild === null || input.windowsBuild < 22621)
    return { supported: false, reason: "os-version" };
  if (!input.hasBackgroundMaterialApi) return { supported: false, reason: "api-unavailable" };
  return { supported: true, material: "windows-mica" };
}

export function resolveWindowMaterial(input: {
  readonly capability: DesktopWindowMaterialCapability;
  readonly enabled: boolean;
  readonly glassOpacity: number;
  readonly reducedTransparency: boolean;
  readonly highContrast: boolean;
  readonly restartRequired: boolean;
  readonly revealed: boolean;
  readonly fullscreen: boolean;
}): { readonly applied: DesktopWindowMaterialKind; readonly reason: DesktopWindowMaterialReason } {
  if (!input.capability.supported) return { applied: "none", reason: "unsupported" };
  if (!input.enabled) return { applied: "none", reason: "off" };
  if (input.reducedTransparency || input.highContrast)
    return { applied: "none", reason: "accessibility" };
  if (input.glassOpacity === 100) return { applied: "none", reason: "opaque" };
  if (input.restartRequired) return { applied: "none", reason: "restart" };
  if (!input.revealed) return { applied: "none", reason: "unrevealed" };
  if (input.fullscreen) return { applied: "none", reason: "fullscreen" };
  return { applied: input.capability.material, reason: "active" };
}
