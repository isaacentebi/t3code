import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { BrowserWindow } from "electron";
import type { DesktopWindowMaterialKind } from "@t3tools/contracts";

export class NativeMaterialError extends Schema.TaggedError<NativeMaterialError>()(
  "NativeMaterialError",
  { cause: Schema.Defect() },
) {}

export interface MaterialAdapter {
  readonly kind: Exclude<DesktopWindowMaterialKind, "none">;
  readonly prepare: () => Effect.Effect<void, NativeMaterialError>;
  readonly attachSync: (
    window: BrowserWindow,
    context: MaterialAppearance,
  ) => {
    readonly updateSync: (context: MaterialAppearance) => void;
    readonly releaseSync: () => void;
  };
}

export interface MaterialAppearance {
  readonly dark: boolean;
  readonly glassOpacity: number;
}

export class WindowMaterialAdapter extends Context.Service<
  WindowMaterialAdapter,
  MaterialAdapter
>()("@t3tools/desktop/window/material/adapters/WindowMaterialAdapter") {}

const windowsMica: MaterialAdapter = {
  kind: "windows-mica",
  prepare: () => Effect.void,
  attachSync: (window) => {
    try {
      window.setBackgroundMaterial("mica");
    } catch (cause) {
      // A native call may mutate before throwing; roll back while the handle is valid.
      window.setBackgroundMaterial("none");
      throw cause;
    }
    let released = false;
    return {
      updateSync: () => {},
      releaseSync: () => {
        if (released) return;
        window.setBackgroundMaterial("none");
        released = true;
      },
    };
  },
};

export const layer = Layer.succeed(WindowMaterialAdapter, windowsMica);
