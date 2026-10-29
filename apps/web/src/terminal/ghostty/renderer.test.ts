import { describe, expect, it } from "vite-plus/test";

import type { GhosttyCell, GhosttyColor, GhosttySnapshot } from "./core";
import { renderGhosttySnapshot } from "./renderer";

const background = { r: 0, g: 0, b: 0 };
const foreground = { r: 255, g: 255, b: 255 };
const explicitBackground = { r: 16, g: 32, b: 48 };

function cell(color: GhosttyColor, selected = false): GhosttyCell {
  return {
    text: "",
    wide: 0,
    foreground,
    background: color,
    bold: false,
    italic: false,
    invisible: false,
    strikethrough: false,
    overline: false,
    underline: false,
    selected,
  };
}

function snapshot(dirtyRows: ReadonlySet<number>): GhosttySnapshot {
  return {
    cols: 2,
    rows: 2,
    foreground,
    background,
    cursor: foreground,
    cursorX: -1,
    cursorY: -1,
    cursorVisible: false,
    cursorBlinking: false,
    cursorStyle: 0,
    dirtyRows,
    rowData: [
      {
        cells: [cell(background), cell(explicitBackground)],
        text: "",
        isWrapContinuation: false,
        wrapsToNext: false,
      },
      {
        cells: [cell(background, true), cell(background)],
        text: "",
        isWrapContinuation: false,
        wrapsToNext: false,
      },
    ],
  };
}

function recordingContext() {
  const paints: Array<{ kind: "clear" | "fill"; color?: string; rect: number[] }> = [];
  const context = {
    canvas: { width: 100, height: 50 },
    fillStyle: "",
    save() {},
    restore() {},
    resetTransform() {},
    clearRect(...rect: number[]) {
      paints.push({ kind: "clear", rect });
    },
    fillRect(...rect: number[]) {
      paints.push({ kind: "fill", color: context.fillStyle, rect });
    },
  };
  return { context: context as unknown as CanvasRenderingContext2D, paints };
}

function draw(
  context: CanvasRenderingContext2D,
  forceFull: boolean,
  transparentBackground: boolean,
) {
  renderGhosttySnapshot({
    context,
    snapshot: snapshot(new Set([0])),
    metrics: { width: 10, height: 10, baseline: 8 },
    fontSize: 12,
    fontFamily: "monospace",
    padding: 4,
    forceFull,
    transparentBackground,
    cursorOn: false,
    selectionBackground: "rgba(72, 122, 191, 0.35)",
  });
}

describe("Ghostty background rendering", () => {
  it("clears the transparent canvas and default-background rows while painting explicit and selected cells", () => {
    const { context, paints } = recordingContext();
    draw(context, true, true);

    expect(paints.filter((paint) => paint.kind === "clear").map((paint) => paint.rect)).toEqual([
      [0, 0, 100, 50],
      [4, 4, 20, 10],
      [4, 14, 20, 10],
    ]);
    expect(paints.filter((paint) => paint.kind === "fill")).toEqual([
      { kind: "fill", color: "rgb(16, 32, 48)", rect: [14, 4, 10, 10] },
      { kind: "fill", color: "rgba(72, 122, 191, 0.35)", rect: [4, 14, 10, 10] },
    ]);

    paints.length = 0;
    draw(context, false, true);
    expect(paints).toEqual([
      { kind: "clear", rect: [4, 4, 20, 10] },
      { kind: "fill", color: "rgb(16, 32, 48)", rect: [14, 4, 10, 10] },
    ]);
  });

  it("keeps the opaque canvas and default rows filled", () => {
    const { context, paints } = recordingContext();
    draw(context, true, false);

    expect(paints.filter((paint) => paint.kind === "clear")).toEqual([]);
    expect(paints.filter((paint) => paint.kind === "fill")).toEqual([
      { kind: "fill", color: "rgb(0, 0, 0)", rect: [0, 0, 100, 50] },
      { kind: "fill", color: "rgb(0, 0, 0)", rect: [4, 4, 20, 10] },
      { kind: "fill", color: "rgb(16, 32, 48)", rect: [14, 4, 10, 10] },
      { kind: "fill", color: "rgb(0, 0, 0)", rect: [4, 14, 20, 10] },
      { kind: "fill", color: "rgba(72, 122, 191, 0.35)", rect: [4, 14, 10, 10] },
    ]);
  });
});
