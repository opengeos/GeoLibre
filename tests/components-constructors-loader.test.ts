import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  __setComponentsModuleLoaderForTests,
  getComponentsConstructors,
  type ComponentsModules,
} from "../packages/plugins/src/plugins/maplibre-components.ts";

// Regression tests for the shared `getComponentsConstructors` singleton that
// lazy-loads maplibre-gl-components for every component control (COG,
// FlatGeobuf, PMTiles, Zarr, Bookmark, Measure, ...). See issue #1130: a
// `vite:preloadError` handler that calls preventDefault() (the stale-chunk
// reload guard, when it defers a reload to protect unsaved work) makes the
// failed dynamic import RESOLVE to `undefined` instead of rejecting.

// A minimal stand-in for the maplibre-gl-components namespace. The constructors
// are never invoked here, so an empty object is enough to pass the loader's
// `if (!components)` guard and reach the success path.
const fakeComponentsModule = {} as unknown as NonNullable<ComponentsModules[0]>;

afterEach(() => {
  // Restore the real dynamic imports and clear the memoized singleton.
  __setComponentsModuleLoaderForTests(null);
});

describe("getComponentsConstructors", () => {
  it("throws a clear, actionable error (not the cryptic destructure) when the module resolves to undefined", async () => {
    __setComponentsModuleLoaderForTests(
      (): Promise<ComponentsModules> => Promise.resolve([undefined, null])
    );

    await assert.rejects(
      getComponentsConstructors(),
      (error: Error) =>
        /could not be loaded/i.test(error.message) &&
        /reload the page/i.test(error.message) &&
        !/destructure/i.test(error.message)
    );
  });

  it("does not memoize a failure: a later call retries the import", async () => {
    let calls = 0;
    __setComponentsModuleLoaderForTests((): Promise<ComponentsModules> => {
      calls += 1;
      return Promise.resolve([undefined, null]);
    });

    await assert.rejects(getComponentsConstructors(), /could not be loaded/i);
    await assert.rejects(getComponentsConstructors(), /could not be loaded/i);

    // A cached rejection would leave this at 1 and break every component
    // control for the life of the page; the retry re-invokes the loader.
    assert.equal(calls, 2);
  });

  it("memoizes a successful load so concurrent controls share one import", async () => {
    let calls = 0;
    __setComponentsModuleLoaderForTests((): Promise<ComponentsModules> => {
      calls += 1;
      return Promise.resolve([fakeComponentsModule, null]);
    });

    const first = await getComponentsConstructors();
    const second = await getComponentsConstructors();

    assert.equal(calls, 1);
    assert.equal(first, second);
  });

  it("recovers once the import succeeds after an earlier failure", async () => {
    let calls = 0;
    __setComponentsModuleLoaderForTests((): Promise<ComponentsModules> => {
      calls += 1;
      return calls === 1
        ? Promise.resolve([undefined, null])
        : Promise.resolve([fakeComponentsModule, null]);
    });

    await assert.rejects(getComponentsConstructors(), /could not be loaded/i);
    const recovered = await getComponentsConstructors();

    assert.ok(recovered);
    assert.equal(calls, 2);
  });
});
