import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ThemeEditorPanel } from "./ThemeEditorPanel";

function dragHeader(panel: HTMLElement, toX: number, toY: number) {
  const header = panel.querySelector<HTMLElement>("h2")!.closest<HTMLElement>(".cursor-grab")!;
  const rect = panel.getBoundingClientRect();
  const start = { clientX: rect.left + 40, clientY: rect.top + 10 };
  const init = { bubbles: true, button: 0, pointerId: 1 };
  header.dispatchEvent(new PointerEvent("pointerdown", { ...init, ...start }));
  header.dispatchEvent(
    new PointerEvent("pointermove", { ...init, clientX: toX + 40, clientY: toY + 10 }),
  );
  header.dispatchEvent(new PointerEvent("pointerup", init));
}

describe("ThemeEditorPanel", () => {
  it("returns to where the user left it when the window shrinks and grows back", async () => {
    await page.viewport(1280, 900);
    // Synthetic pointer ids are not active pointers, so the browser would reject capture.
    using _capture = vi
      .spyOn(HTMLElement.prototype, "setPointerCapture")
      .mockImplementation(() => {});
    // Tailwind is not loaded here; give the panel its fixed, card-sized box.
    const style = document.head.appendChild(document.createElement("style"));
    style.textContent = "[data-theme-editor-panel]{position:fixed;width:400px;height:300px}";
    using _style = { [Symbol.dispose]: () => style.remove() };
    await using screen = await render(
      <ThemeEditorPanel
        open
        onOpenChange={() => {}}
        onSaved={() => true}
        editingTheme={null}
        initialAppearance="dark"
        restoreTheme={() => {}}
      />,
    );
    const panel = screen.getByRole("dialog", { name: "Create theme" });
    await expect.element(panel).toBeVisible();

    dragHeader(panel.element() as HTMLElement, 700, 40);
    await expect.poll(() => (panel.element() as HTMLElement).style.left).toBe("700px");

    await page.viewport(600, 900);
    await expect
      .poll(() => Number.parseFloat((panel.element() as HTMLElement).style.left))
      .toBeLessThan(600);

    await page.viewport(1280, 900);
    await expect.poll(() => (panel.element() as HTMLElement).style.left).toBe("700px");
  });
});
