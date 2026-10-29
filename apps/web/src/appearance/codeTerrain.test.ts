import { expect, it } from "vite-plus/test";
import { planCodeTerrain } from "./codeTerrain";

it.each([
  { width: 32, height: 28 },
  { width: 4096, height: 320 },
])("keeps every terrain glyph inside a $width by $height viewport", ({ width, height }) => {
  const glyphs = planCodeTerrain({ width, height, cell: { w: 9, h: 14 }, seed: 17 });
  if (width > 1000) expect(glyphs.length).toBeGreaterThan(0);
  for (const glyph of glyphs) {
    expect(glyph.x).toBeGreaterThanOrEqual(0);
    expect(glyph.x).toBeLessThan(width);
    expect(glyph.y).toBeGreaterThanOrEqual(0);
    expect(glyph.y).toBeLessThanOrEqual(height);
  }
});
