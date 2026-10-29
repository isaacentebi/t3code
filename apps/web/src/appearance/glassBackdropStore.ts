import { useEffect, useState } from "react";

const MAX_BACKDROP_SOURCE_BYTES = 25 * 1024 * 1024;
export const MAX_BACKDROP_EDGE = 2560;
export type BackdropSaveError = "not-image" | "too-large" | "unreadable";

const STORE_NAME = "images";
const IMAGE_KEY = "custom";
// Each operation opens and closes its own connection.
function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("t3code:glass-backdrop", 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () =>
      reject(new Error("Glass backdrop store is blocked.")),
    );
  });
}
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function completed(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = use(transaction.objectStore(STORE_NAME));
    await completed(transaction);
    return request.result;
  } finally {
    database.close();
  }
}

function encode(canvas: HTMLCanvasElement, type: string) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.88));
}

export async function saveCustomBackdrop(
  file: Blob,
): Promise<{ ok: true } | { ok: false; error: BackdropSaveError }> {
  if (!file.type.startsWith("image/")) return { ok: false, error: "not-image" };
  if (file.size > MAX_BACKDROP_SOURCE_BYTES) return { ok: false, error: "too-large" };
  try {
    const bitmap = await createImageBitmap(file);
    let encoded: Blob | null;
    try {
      if (bitmap.width < 1 || bitmap.height < 1) return { ok: false, error: "unreadable" };
      const scale = Math.min(1, MAX_BACKDROP_EDGE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return { ok: false, error: "unreadable" };
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      encoded = await encode(canvas, "image/webp");
      if (!encoded || encoded.type !== "image/webp") encoded = await encode(canvas, "image/jpeg");
    } finally {
      bitmap.close();
    }
    if (!encoded) return { ok: false, error: "unreadable" };
    await withStore("readwrite", (store) => store.put(encoded, IMAGE_KEY));
    notify();
    return { ok: true };
  } catch {
    return { ok: false, error: "unreadable" };
  }
}

export async function loadCustomBackdrop(): Promise<Blob | null> {
  const value: unknown = await withStore("readonly", (store) => store.get(IMAGE_KEY));
  return value instanceof Blob ? value : null;
}

export async function clearCustomBackdrop(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(IMAGE_KEY));
  notify();
}

export function subscribeCustomBackdrop(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCustomBackdropPresence(): "loading" | "present" | "missing" {
  const [presence, setPresence] = useState<"loading" | "present" | "missing">("loading");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- IndexedDB presence updates outside React after local writes.
  useEffect(() => {
    let current = true;
    const refresh = () => {
      void loadCustomBackdrop().then(
        (blob) => {
          if (current) setPresence(blob ? "present" : "missing");
        },
        () => {
          if (current) setPresence("missing");
        },
      );
    };
    const unsubscribe = subscribeCustomBackdrop(refresh);
    refresh();
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);
  return presence;
}
