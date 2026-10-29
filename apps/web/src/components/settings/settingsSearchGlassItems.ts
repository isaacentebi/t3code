import type { SettingsSearchItem } from "./settingsSearch";

export const GLASS_SETTINGS_SEARCH_ITEMS = [
  {
    id: "appearance-style",
    title: "Style",
    to: "/settings/appearance",
    searchTerms: ["liquid glass transparent translucent wallpaper preset frosted"],
  },
  {
    id: "appearance-background",
    title: "Background",
    to: "/settings/appearance",
    searchTerms: ["wallpaper backdrop image custom liquid glass"],
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    title: "Glass opacity",
    to: "/settings/appearance",
    searchTerms: ["transparent transparency solid menus dialogs composer"],
  },
  {
    id: "desktop-system-material",
    title: "System glass",
    to: "/settings/appearance",
    searchTerms: ["native transparency mica windows liquid glass macos accessibility"],
    desktopOnly: true,
    requiresDesktopWindowMaterial: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
