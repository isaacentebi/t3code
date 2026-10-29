export interface TerrainGlyph {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly alpha: number;
}

const WORDS =
  "git worktree agent thread turn commit branch diff async await provider checkpoint T3 Code";

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function planCodeTerrain(input: {
  width: number;
  height: number;
  cell: { w: number; h: number };
  seed: number;
}): ReadonlyArray<TerrainGlyph> {
  const { width, height, cell } = input;
  if (width <= 0 || height <= 0 || cell.w <= 0 || cell.h <= 0) return [];
  const next = random(input.seed);
  const ridgeCount = 2 + Math.floor(next() * 2);
  const ridges = Array.from({ length: ridgeCount }, (_, index) => ({
    center: 0.4 + index * 0.09 + next() * 0.05,
    phase: next() * Math.PI * 2,
    frequency: 1.1 + next() * 1.1,
    amplitude: 0.1 + next() * 0.06,
  }));
  const glyphs: TerrainGlyph[] = [];
  const columns = Math.floor(width / cell.w);
  const rows = Math.floor(height / cell.h);
  let wordIndex = Math.floor(next() * WORDS.length);
  for (let row = 0; row < rows; row++) {
    const y = (row + 1) * cell.h;
    const position = y / height;
    for (let column = 0; column < columns; column++) {
      const x = column * cell.w;
      const horizontal = x / width;
      let strength = 0;
      for (const ridge of ridges) {
        const crest =
          ridge.center +
          Math.sin(horizontal * Math.PI * 2 * ridge.frequency + ridge.phase) * ridge.amplitude +
          Math.sin(horizontal * Math.PI * 5.6 + ridge.phase * 0.7) * 0.027 +
          Math.sin(horizontal * Math.PI * 13.2 + ridge.phase * 1.3) * 0.009;
        const depth = position - crest;
        const contribution =
          depth >= 0
            ? Math.exp(-depth * 6.5) * (0.55 + 0.45 * Math.exp(-depth * 30))
            : Math.exp(depth * 80) * 0.06;
        strength = Math.max(strength, contribution);
      }
      const density = Math.min(0.9, strength * 0.95);
      if (next() >= density) continue;
      const text = WORDS[wordIndex % WORDS.length] ?? "G";
      wordIndex += 1;
      glyphs.push({ x, y, text, alpha: Math.min(0.7, 0.08 + strength * (0.35 + next() * 0.3)) });
    }
  }
  return glyphs;
}

export function drawCodeTerrain(
  context: CanvasRenderingContext2D,
  input: { width: number; height: number; dark: boolean; seed?: number },
): void {
  const { width, height, dark } = input;
  context.fillStyle = dark ? "#0b0b0c" : "#efe9df";
  context.fillRect(0, 0, width, height);
  context.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  context.textBaseline = "bottom";
  for (const glyph of planCodeTerrain({
    width,
    height,
    cell: { w: 9, h: 14 },
    seed: input.seed ?? 2710,
  })) {
    context.fillStyle = dark
      ? `rgba(217, 164, 65, ${glyph.alpha})`
      : `rgba(56, 63, 73, ${glyph.alpha})`;
    context.fillText(glyph.text, glyph.x, glyph.y);
  }
}
