import { describe, expect, it } from "vite-plus/test";
import { probeCapability, resolveWindowMaterial } from "./materialPolicy.ts";

const input = {
  capability: { supported: true, material: "windows-mica" } as const,
  enabled: true,
  glassOpacity: 80,
  reducedTransparency: false,
  highContrast: false,
  restartRequired: false,
  revealed: true,
  fullscreen: false,
};

describe("window material policy", () => {
  it.each([
    ["darwin", 25, null, true, { supported: false, reason: "api-unavailable" }],
    ["darwin", 26, null, true, { supported: false, reason: "api-unavailable" }],
    ["linux", null, null, true, { supported: false, reason: "platform" }],
    ["win32", null, 22000, true, { supported: false, reason: "os-version" }],
    ["win32", null, null, true, { supported: false, reason: "os-version" }],
    ["win32", null, 22621, false, { supported: false, reason: "api-unavailable" }],
    ["win32", null, 22621, true, { supported: true, material: "windows-mica" }],
  ] as const)(
    "gates %s macOS %s Windows %s API %s",
    (platform, macOSMajor, windowsBuild, hasBackgroundMaterialApi, expected) => {
      expect(
        probeCapability({ platform, macOSMajor, windowsBuild, hasBackgroundMaterialApi }),
      ).toEqual(expected);
    },
  );

  it.each([
    [{}, "active", "windows-mica"],
    [{ enabled: false }, "off", "none"],
    [{ glassOpacity: 100 }, "opaque", "none"],
    [{ reducedTransparency: true }, "accessibility", "none"],
    [{ highContrast: true }, "accessibility", "none"],
    [{ restartRequired: true }, "restart", "none"],
    [{ revealed: false }, "unrevealed", "none"],
    [{ fullscreen: true }, "fullscreen", "none"],
    [{ capability: { supported: false, reason: "platform" } }, "unsupported", "none"],
  ] as const)("resolves %j to %s", (override, reason, applied) => {
    expect(resolveWindowMaterial({ ...input, ...override })).toEqual({ applied, reason });
  });
});
