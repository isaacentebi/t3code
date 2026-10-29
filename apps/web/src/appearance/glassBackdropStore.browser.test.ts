import { expect, it } from "vite-plus/test";
import {
  clearCustomBackdrop,
  loadCustomBackdrop,
  MAX_BACKDROP_EDGE,
  saveCustomBackdrop,
} from "./glassBackdropStore";

it("saves a downscaled image and clears it from local storage", async () => {
  const source = document.createElement("canvas");
  source.width = MAX_BACKDROP_EDGE + 16;
  source.height = 24;
  const context = source.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.fillStyle = "#a17442";
  context.fillRect(0, 0, source.width, source.height);
  const image = await new Promise<Blob | null>((resolve) => source.toBlob(resolve, "image/png"));
  if (!image) throw new Error("Image encoding failed");
  try {
    expect(await saveCustomBackdrop(image)).toEqual({ ok: true });
    const saved = await loadCustomBackdrop();
    expect(saved?.type).toMatch(/^image\/(webp|jpeg)$/);
    if (!saved) throw new Error("Missing saved image");
    const bitmap = await createImageBitmap(saved);
    try {
      expect(Math.max(bitmap.width, bitmap.height)).toBeLessThanOrEqual(MAX_BACKDROP_EDGE);
    } finally {
      bitmap.close();
    }
  } finally {
    await clearCustomBackdrop();
  }
  expect(await loadCustomBackdrop()).toBeNull();
});

it("rejects a non-image without changing the stored backdrop", async () => {
  await clearCustomBackdrop();
  expect(await saveCustomBackdrop(new Blob(["hello"], { type: "text/plain" }))).toEqual({
    ok: false,
    error: "not-image",
  });
  expect(await loadCustomBackdrop()).toBeNull();
});
