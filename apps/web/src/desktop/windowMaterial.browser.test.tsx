import { expect, it } from "vite-plus/test";
import { act, render } from "../../test/render";
import { materialBridge, materialState } from "../../test/windowMaterial";
import { ComposerSurface } from "../components/chat/ComposerSurface";
import { ComposerBanner } from "../components/chat/ComposerBanner";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { persistClientSettingsPatch } from "../hooks/useSettings";
import { DesktopWindowMaterialSync } from "./DesktopWindowMaterialSync";
import "../index.css";

function Shell() {
  return (
    <>
      <DesktopWindowMaterialSync />
      <div data-app-sidebar>
        <div data-slot="sidebar-inner" className="bg-sidebar before:bg-sidebar" />
      </div>
      <SidebarInset>
        <div data-testid="chat-shell" className="bg-background">
          <div data-chat-column>
            <header data-chat-header className="bg-background" />
          </div>
          <div data-testid="transcript" className="bg-background">
            Transcript
          </div>
        </div>
        <div data-testid="settings-shell" className="bg-background">
          <WorkspacePageHeader />
        </div>
      </SidebarInset>
      <div className="surface-glass" />
      <div className="alert-glass" data-variant="error" />
      <div className="dialog-glass" />
      <div className="dialog-backdrop" />
      <div className="dropdown-glass" />
      <ComposerSurface.Shell>
        <ComposerBanner.Surface />
        <ComposerSurface.Main />
        <ComposerSurface.ContextStrip />
      </ComposerSurface.Shell>
      <ComposerBanner.Surface />
    </>
  );
}

function alpha(element: Element, pseudo?: string) {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.fillStyle = getComputedStyle(element, pseudo).backgroundColor;
  context.fillRect(0, 0, 1, 1);
  return context.getImageData(0, 0, 1, 1).data[3];
}

function element(container: HTMLElement, selector: string) {
  const found = container.querySelector(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}

it("exposes only native chrome, keeps content and overlays solid, and restores CSS glass", async () => {
  using fixture = materialBridge();
  await using screen = await render(<Shell />);
  const root = document.documentElement;
  expect(alpha(root)).toBe(0);
  expect(alpha(document.body)).toBe(0);
  expect(getComputedStyle(document.body).backgroundImage).toBe("none");
  for (const selector of [
    '[data-slot="sidebar-inner"]',
    "[data-chat-header]",
    "[data-workspace-page-header]",
  ]) {
    expect(alpha(element(screen.container, selector))).toBe(0);
  }
  expect(alpha(element(screen.container, '[data-slot="sidebar-inner"]'), "::before")).toBe(0);
  for (const selector of [
    "[data-native-material-band]",
    '[data-testid="chat-shell"]',
    '[data-testid="settings-shell"]',
  ]) {
    expect(getComputedStyle(element(screen.container, selector)).backgroundImage).toContain(
      "linear-gradient",
    );
  }
  expect(alpha(element(screen.container, '[data-testid="transcript"]'))).toBe(255);
  for (const selector of [".dialog-glass", ".dialog-backdrop", ".dropdown-glass"]) {
    const node = element(screen.container, selector);
    expect(alpha(node)).toBe(255);
    expect(getComputedStyle(node).backdropFilter).toBe("none");
  }
  await act(() => fixture.push(materialState({ revision: 2, applied: "none", reason: "off" })));
  expect(alpha(root)).toBe(255);
  expect(alpha(element(screen.container, ".surface-glass"))).toBeLessThan(255);
  expect(getComputedStyle(element(screen.container, ".surface-glass")).backdropFilter).toContain(
    "blur(",
  );
  await act(() => persistClientSettingsPatch({ glassOpacity: 100 }));
  assertOpaque(screen.container);
  await act(() => persistClientSettingsPatch({ glassOpacity: 80 }));
  for (const [index, flags] of [{ reducedTransparency: true }, { highContrast: true }].entries()) {
    await act(() =>
      fixture.push(
        materialState({ revision: 3 + index, applied: "none", reason: "accessibility", ...flags }),
      ),
    );
    assertOpaque(screen.container);
  }
  await act(() => fixture.push(materialState({ revision: 5, applied: "none", reason: "off" })));
  expect(alpha(element(screen.container, ".surface-glass"))).toBeLessThan(255);
  expect(
    getComputedStyle(element(screen.container, '[data-slot="composer-shell"]'), "::before")
      .backdropFilter,
  ).toContain("blur(");
  expect(root.style.getPropertyValue("--glass-opacity")).toBe("80%");
  expect(root.style.getPropertyValue("--glass-saturation")).toBe("");
});

function assertOpaque(container: HTMLElement) {
  for (const selector of [
    ".surface-glass",
    ".alert-glass",
    ".dialog-glass",
    ".dialog-backdrop",
    ".dropdown-glass",
    "[data-chat-composer-main-surface]",
  ]) {
    const node = element(container, selector);
    expect(alpha(node)).toBe(255);
    expect(getComputedStyle(node).backdropFilter).toBe("none");
  }
  for (const selector of ['[data-slot="composer-shell"]', "[data-composer-banner-surface]"]) {
    const node = element(container, selector);
    expect(alpha(node, "::before"), selector).toBe(255);
    expect(getComputedStyle(node, "::before").backdropFilter).toBe("none");
  }
}

it("clears the theme-synced inline page background while native material is active", async () => {
  using _fixture = materialBridge();
  const root = document.documentElement;
  // syncBrowserChromeTheme writes these inline colors for the browser chrome.
  root.style.backgroundColor = "rgb(23, 23, 23)";
  document.body.style.backgroundColor = "rgb(23, 23, 23)";
  try {
    await using _screen = await render(<Shell />);
    expect(alpha(root)).toBe(0);
    expect(alpha(document.body)).toBe(0);
  } finally {
    root.style.removeProperty("background-color");
    document.body.style.removeProperty("background-color");
  }
});

it("leaves browser glass and root attributes unchanged without a desktop bridge", async () => {
  using _fixture = materialBridge();
  delete window.desktopBridge;
  await using screen = await render(<Shell />);
  expect(document.documentElement.hasAttribute("data-desktop-client")).toBe(false);
  expect(document.documentElement.hasAttribute("data-desktop-window-material")).toBe(false);
  expect(document.documentElement.hasAttribute("data-desktop-glass-opaque")).toBe(false);
  const glass = element(screen.container, ".surface-glass");
  expect(alpha(glass)).toBeLessThan(255);
  expect(getComputedStyle(glass).backdropFilter).toContain("blur(");
  expect(alpha(document.documentElement)).toBe(255);
});
