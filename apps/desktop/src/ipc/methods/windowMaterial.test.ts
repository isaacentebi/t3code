import { assert, describe, it } from "@effect/vitest";
import { DesktopWindowMaterialState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { BrowserWindow } from "electron";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as Material from "../../window/material/DesktopWindowMaterial.ts";
import { getWindowMaterialState } from "./windowMaterial.ts";

const decodeState = Schema.decodeUnknownEffect(DesktopWindowMaterialState);

const state: DesktopWindowMaterialState = {
  revision: 4,
  capability: { supported: false, reason: "api-unavailable" },
  enabled: true,
  applied: "none",
  reason: "unsupported",
  reducedTransparency: false,
  highContrast: false,
};

const layer = (hasMain = true) =>
  Layer.mergeAll(
    Layer.mock(ElectronWindow.ElectronWindow)({
      main: hasMain
        ? Effect.succeedSome({
            webContents: { id: 10 },
            isDestroyed: () => false,
          } as BrowserWindow)
        : Effect.succeedNone,
    }),
    Layer.mock(Material.DesktopWindowMaterial)({ getState: () => Effect.succeed(state) }),
  );

describe("window material IPC", () => {
  it.effect.each([undefined, { sender: { id: 11 } }])(
    "rejects a sender other than the main window: %j",
    (event) =>
      Effect.gen(function* () {
        const result = yield* getWindowMaterialState.handler(undefined, event).pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result))
          assert.instanceOf(result.failure, Material.WindowMaterialSenderError);
      }).pipe(Effect.provide(layer())),
  );

  it.effect("rejects a main sender after the main window has gone away", () =>
    Effect.gen(function* () {
      const result = yield* getWindowMaterialState
        .handler(undefined, { sender: { id: 10 } })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result))
        assert.instanceOf(result.failure, Material.WindowMaterialSenderError);
    }).pipe(Effect.provide(layer(false))),
  );

  it.effect("returns a state that survives the invoke serialization and schema decoding", () =>
    Effect.gen(function* () {
      const encoded = yield* getWindowMaterialState.handler(undefined, { sender: { id: 10 } });
      const received: unknown = JSON.parse(JSON.stringify(encoded));
      assert.deepEqual(yield* decodeState(received), state);
    }).pipe(Effect.provide(layer())),
  );
});
