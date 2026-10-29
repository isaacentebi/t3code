import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { NativeMaterialError } from "../window/material/adapters.ts";

export interface ObjcRuntime {
  readonly classNamed: (name: string) => bigint;
  readonly selector: (name: string) => bigint;
  readonly encoding: (
    cls: bigint,
    selector: bigint,
    dispatch: "class" | "instance",
  ) => string | null;
  readonly pointer: (receiver: bigint, selector: bigint, args?: readonly bigint[]) => bigint;
  readonly void: (receiver: bigint, selector: bigint, args?: readonly bigint[]) => void;
  readonly bool: (receiver: bigint, selector: bigint) => boolean;
  readonly setBool: (receiver: bigint, selector: bigint, value: boolean) => void;
  readonly color: (receiver: bigint, selector: bigint, rgba: readonly number[]) => bigint;
}

export class MacosObjcRuntime extends Context.Service<
  MacosObjcRuntime,
  { readonly load: Effect.Effect<ObjcRuntime, NativeMaterialError> }
>()("@t3tools/desktop/electron/MacosObjcRuntime") {}

// Importing this module is safe; ffi-rs loads only when a supported Mac first attaches glass.
async function loadRuntime(): Promise<ObjcRuntime> {
  const { DataType, load, open } = await import("ffi-rs");
  const library = "t3-material-objc";
  open({ library, path: "/usr/lib/libobjc.A.dylib" });
  open({
    library: "t3-material-appkit",
    path: "/System/Library/Frameworks/AppKit.framework/AppKit",
  });
  const P = DataType.BigInt;
  // ffi-rs types its scalar as boxed BigInt; the port exposes primitive bigint only.
  const pointerCall = (
    funcName: string,
    paramsType: import("ffi-rs").DataType[],
    paramsValue: unknown[],
  ) =>
    load({
      library,
      funcName,
      retType: P,
      paramsType,
      paramsValue,
      runInNewThread: false,
    }).valueOf();
  return {
    classNamed: (name) => pointerCall("objc_getClass", [DataType.String], [name]),
    selector: (name) => pointerCall("sel_registerName", [DataType.String], [name]),
    encoding: (cls, selector, dispatch) => {
      const method = pointerCall(
        dispatch === "class" ? "class_getClassMethod" : "class_getInstanceMethod",
        [P, P],
        [cls, selector],
      );
      if (method === 0n) return null;
      // Check the C string pointer before asking ffi-rs to decode it.
      if (pointerCall("method_getTypeEncoding", [P], [method]) === 0n) return null;
      return load({
        library,
        funcName: "method_getTypeEncoding",
        retType: DataType.String,
        paramsType: [P],
        paramsValue: [method],
        runInNewThread: false,
      });
    },
    pointer: (receiver, selector, args = []) =>
      pointerCall("objc_msgSend", [P, P, ...args.map(() => P)], [receiver, selector, ...args]),
    void: (receiver, selector, args = []) => {
      load({
        library,
        funcName: "objc_msgSend",
        retType: DataType.Void,
        paramsType: [P, P, ...args.map(() => P)],
        paramsValue: [receiver, selector, ...args],
        runInNewThread: false,
      });
    },
    bool: (receiver, selector) =>
      load({
        library,
        funcName: "objc_msgSend",
        retType: DataType.U8,
        paramsType: [P, P],
        paramsValue: [receiver, selector],
        runInNewThread: false,
      }) !== 0,
    setBool: (receiver, selector, value) => {
      load({
        library,
        funcName: "objc_msgSend",
        retType: DataType.Void,
        paramsType: [P, P, DataType.U8],
        paramsValue: [receiver, selector, value ? 1 : 0],
        runInNewThread: false,
      });
    },
    color: (receiver, selector, rgba) =>
      pointerCall(
        "objc_msgSend",
        [P, P, DataType.Double, DataType.Double, DataType.Double, DataType.Double],
        [receiver, selector, ...rgba],
      ),
  };
}

export const layer = Layer.succeed(MacosObjcRuntime, {
  load: Effect.tryPromise({
    try: loadRuntime,
    catch: (cause) => new NativeMaterialError({ cause }),
  }),
});
