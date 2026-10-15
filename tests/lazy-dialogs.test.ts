import assert from "node:assert/strict";
import { it } from "node:test";
import { loadLazyDialog } from "../apps/geolibre-desktop/src/components/layout/toolbar/LazyDialogs";

function Dialog() {
  return null;
}

/** Runs `fn` with console.error silenced, returning how many times it was called. */
async function countConsoleErrors(fn: () => Promise<void>): Promise<number> {
  const original = console.error;
  let calls = 0;
  console.error = () => {
    calls += 1;
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return calls;
}

it("resolves a loaded dialog as the lazy module's default", async () => {
  const module = await loadLazyDialog("Dialog", async () => Dialog);
  assert.equal(module.default, Dialog);
});

it("falls back to an empty dialog when Vite's preload wrapper resolves undefined", async () => {
  // A vite:preloadError listener that calls preventDefault() makes the wrapped
  // import resolve to undefined; React.lazy would read `.default` off it.
  let module: { default: typeof Dialog } | undefined;
  const errors = await countConsoleErrors(async () => {
    module = await loadLazyDialog<typeof Dialog>("Dialog", async () => undefined);
  });
  assert.equal(typeof module?.default, "function");
  assert.notEqual(module?.default, Dialog);
  assert.equal(module?.default(), null);
  assert.equal(errors, 1);
});

it("falls back to an empty dialog when the chunk fails to load", async () => {
  let module: { default: typeof Dialog } | undefined;
  const errors = await countConsoleErrors(async () => {
    module = await loadLazyDialog<typeof Dialog>("Dialog", async () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    });
  });
  assert.equal(module?.default(), null);
  assert.equal(errors, 1);
});
