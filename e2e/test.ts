import { test as base } from "@playwright/test";

export * from "@playwright/test";

/**
 * How long a page may take to unload. Under SwiftShader a map page takes
 * ~6 s on one core; the cap only keeps a wedged page from holding a passing
 * test open.
 */
const UNLOAD_TIMEOUT_MS = 20_000;

/**
 * `@playwright/test`'s `test`, with one change: a passing test's pages are
 * navigated to `about:blank` before Playwright disposes its browser context.
 * Every spec imports `test` from here, not from `@playwright/test`.
 *
 * Disposing a context kills its renderer outright. When that renderer still
 * holds a live software-rendered (SwiftShader) WebGL map, the browser process
 * is left wedged, and the *next* test in the worker pays for it: its
 * `browser.newContext()` took 3 s to over 60 s, all charged to that test's
 * own timeout. That is how a spec fails its first attempt "while setting up
 * context", or runs out of time partway through, and then passes on retry
 * (#2879). Navigating away first lets the page unload in order, a bounded few
 * seconds in the test that owns it, and the next context then opens in ~0.1 s.
 *
 * A failing test is left as it is: Playwright restarts the worker after a
 * failure, so no later test shares its browser, and blanking the page would
 * wipe the failure screenshot and page snapshot.
 */
export const test = base.extend({
  context: async ({ context }, use, testInfo) => {
    await use(context);
    if (testInfo.status !== testInfo.expectedStatus) return;
    // The unload runs after the test body, so give it its own budget rather
    // than failing a test that finished near its timeout.
    // A timeout of 0 means none (`--debug`), which must stay unlimited.
    if (testInfo.timeout > 0) testInfo.setTimeout(testInfo.timeout + UNLOAD_TIMEOUT_MS);
    await Promise.all(
      context
        .pages()
        .map((page) =>
          page.goto("about:blank", { timeout: UNLOAD_TIMEOUT_MS }).catch(() => undefined),
        ),
    );
  },
});
