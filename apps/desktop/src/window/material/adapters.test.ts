import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { BrowserWindow } from "electron";
import * as Adapters from "./adapters.ts";

it.effect("Mica attachment restores the native material once without changing backing color", () =>
  Effect.gen(function* () {
    const adapter = yield* Adapters.WindowMaterialAdapter;
    let material = "none";
    let releases = 0;
    const window = {
      setBackgroundMaterial: (value: string) => {
        material = value;
        if (value === "none") releases++;
      },
      setBackgroundColor: () => {
        throw new Error("adapter cannot own the backing color");
      },
    } as unknown as BrowserWindow;
    yield* adapter.prepare();
    const attachment = adapter.attachSync(window, { dark: false, glassOpacity: 80 });
    assert.equal(material, "mica");
    attachment.releaseSync();
    attachment.releaseSync();
    assert.equal(material, "none");
    assert.equal(releases, 1);
  }).pipe(Effect.provide(Adapters.layer)),
);

it.effect("a partially failed native Mica call is rolled back", () =>
  Effect.gen(function* () {
    const adapter = yield* Adapters.WindowMaterialAdapter;
    let material = "none";
    const window = {
      setBackgroundMaterial: (value: string) => {
        material = value;
        if (value === "mica") throw new Error("native failed after mutation");
      },
    } as BrowserWindow;
    assert.throws(() => adapter.attachSync(window, { dark: false, glassOpacity: 80 }));
    assert.equal(material, "none");
  }).pipe(Effect.provide(Adapters.layer)),
);
