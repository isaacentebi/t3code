import { assert, it } from "@effect/vitest";
import type { BrowserWindow } from "electron";
import { probeMacosGlass } from "./macosGlassAdapter.ts";
import { fakeObjcRuntime } from "./macosGlassTestFixture.ts";

function windowHandle(handle = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])) {
  return { isDestroyed: () => false, getNativeWindowHandle: () => handle } as BrowserWindow;
}

it.each([
  "alloc-null",
  "init-null",
  "tamic",
  "insert",
  "anchor-null",
  "constraint-null",
  "activation",
  "color-null",
  "tint",
])("%s attachment failure leaves no live view or active constraints", (fail) => {
  const { runtime, state } = fakeObjcRuntime({ fail });
  const adapter = probeMacosGlass(runtime);
  assert.throws(() => adapter.attachSync(windowHandle(), { dark: false, glassOpacity: 80 }));
  assert.equal(state.liveViews.size, 0);
  assert.equal(state.activeConstraints.size, 0);
});

it.each([Buffer.alloc(4), Buffer.alloc(8)])(
  "invalid native handle fails before allocation",
  (handle) => {
    const { runtime, state } = fakeObjcRuntime();
    const adapter = probeMacosGlass(runtime);
    assert.throws(() =>
      adapter.attachSync(windowHandle(handle), { dark: false, glassOpacity: 80 }),
    );
    assert.equal(state.allocations, 0);
  },
);

it("release is idempotent and later updates never message released native objects", () => {
  const { runtime, state } = fakeObjcRuntime();
  const attachment = probeMacosGlass(runtime).attachSync(windowHandle(), {
    dark: true,
    glassOpacity: 40,
  });
  assert.deepEqual(state.tints[0], [0.11, 0.11, 0.12, 0.35]);
  attachment.updateSync({ dark: false, glassOpacity: 100 });
  assert.deepEqual(state.tints.at(-1), [0.96, 0.96, 0.97, 0.85]);
  attachment.releaseSync();
  const mutations = state.mutations;
  attachment.releaseSync();
  attachment.updateSync({ dark: true, glassOpacity: 80 });
  assert.equal(state.mutations, mutations);
  assert.equal(state.liveViews.size, 0);
  assert.equal(state.activeConstraints.size, 0);
});
