import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const MIN_GLASS_OPACITY = 40;
export const MAX_GLASS_OPACITY = 100;
export const GlassOpacity = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_GLASS_OPACITY,
    maximum: MAX_GLASS_OPACITY,
  }),
);
export type GlassOpacity = typeof GlassOpacity.Type;
const DEFAULT_GLASS_OPACITY: GlassOpacity = 80;

const AppearancePreset = Schema.Literals(["default", "liquid-glass"]);
export type AppearancePreset = typeof AppearancePreset.Type;

const GlassBackdrop = Schema.Literals(["built-in", "custom"]);
export type GlassBackdrop = typeof GlassBackdrop.Type;

// Spread into ClientSettingsSchema and ClientSettingsPatch, which sit at their code budget.
export const GlassClientSettingFields = {
  glassOpacity: GlassOpacity.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_GLASS_OPACITY)),
  ),
  desktopSystemMaterialEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  appearancePreset: AppearancePreset.pipe(
    Schema.withDecodingDefault(Effect.succeed<AppearancePreset>("default")),
  ),
  glassBackdrop: GlassBackdrop.pipe(
    Schema.withDecodingDefault(Effect.succeed<GlassBackdrop>("built-in")),
  ),
};
export const GlassClientSettingPatchFields = {
  glassOpacity: Schema.optionalKey(GlassOpacity),
  desktopSystemMaterialEnabled: Schema.optionalKey(Schema.Boolean),
  appearancePreset: Schema.optionalKey(AppearancePreset),
  glassBackdrop: Schema.optionalKey(GlassBackdrop),
};

/** The Liquid Glass style asks for the system material without changing the System glass switch. */
export function isSystemMaterialRequested(settings: {
  readonly desktopSystemMaterialEnabled: boolean;
  readonly appearancePreset: AppearancePreset;
}): boolean {
  return settings.desktopSystemMaterialEnabled || settings.appearancePreset === "liquid-glass";
}

export const DesktopWindowMaterialKind = Schema.Literals(["none", "macos-glass", "windows-mica"]);
export type DesktopWindowMaterialKind = typeof DesktopWindowMaterialKind.Type;

export const DesktopWindowMaterialCapability = Schema.Union([
  Schema.Struct({
    supported: Schema.Literal(true),
    material: Schema.Literals(["macos-glass", "windows-mica"]),
  }),
  Schema.Struct({
    supported: Schema.Literal(false),
    reason: Schema.Literals(["platform", "os-version", "api-unavailable"]),
  }),
]);
export type DesktopWindowMaterialCapability = typeof DesktopWindowMaterialCapability.Type;

export const DesktopWindowMaterialReason = Schema.Literals([
  "active",
  "off",
  "opaque",
  "accessibility",
  "unrevealed",
  "fullscreen",
  "unsupported",
  "native-failed",
  "restart",
]);
export type DesktopWindowMaterialReason = typeof DesktopWindowMaterialReason.Type;

/** What the desktop main process actually applied to the window that asked. */
export const DesktopWindowMaterialState = Schema.Struct({
  revision: Schema.Int,
  capability: DesktopWindowMaterialCapability,
  enabled: Schema.Boolean,
  applied: DesktopWindowMaterialKind,
  reducedTransparency: Schema.Boolean,
  highContrast: Schema.Boolean,
  reason: DesktopWindowMaterialReason,
});
export type DesktopWindowMaterialState = typeof DesktopWindowMaterialState.Type;

// Optional so older desktop builds and plain browsers keep the CSS-only path.
export interface DesktopWindowMaterialBridge {
  getWindowMaterialState?: () => Promise<DesktopWindowMaterialState>;
  onWindowMaterialStateChanged?: (
    listener: (state: DesktopWindowMaterialState) => void,
  ) => () => void;
  /** Quits and reopens the app so a new window can be created transparent for macOS glass. */
  relaunchForWindowMaterial?: () => Promise<void>;
}
