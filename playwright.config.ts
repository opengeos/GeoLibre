import { defineConfig, devices } from "@playwright/test";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "./apps/geolibre-desktop/src/lib/storage-keys";

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

/**
 * The `core` suite: the app boots and renders a map, and its shared UI surfaces
 * still work. This is the only suite that gates a pull request, so it is kept
 * to the checks that would break *every* user — not per-feature integration.
 *
 * Everything else lands in the `features` project, which runs nightly (see
 * `.github/workflows/e2e-full.yml`). Feature specs are not less valuable — most
 * were written for a specific shipped regression — they are just too slow to
 * charge to every commit: the full suite is ~36 min serial, of which these are
 * ~27 min. Moving a spec between the two lists is the intended way to trade
 * per-commit cost against how fast a regression is caught.
 */
const CORE_SPECS = [
  "smoke.spec.ts", // the app loads, a layer renders, the attribute table opens
  "theme.spec.ts",
  "a11y.spec.ts",
  "layer-panel.spec.ts",
  "drop-overlay.spec.ts",
  "set-view.spec.ts",
  "error-handling.spec.ts",
  "attribute-status.spec.ts",
  "paste-style.spec.ts",
  "rtl.spec.ts",
  "pwa.spec.ts",
  "style-manager.spec.ts",
];

const coreMatch = CORE_SPECS.map((spec) => `**/${spec}`);

// MapLibre needs a WebGL context; force software ANGLE/SwiftShader so the map
// initializes on headless CI runners without a real GPU.
const chromium = {
  ...devices["Desktop Chrome"],
  launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader"] },
};

// End-to-end smoke tests run against the *built* web app served by `vite
// preview` (matching production output), not the dev server. The webServer
// command builds first so the suite is self-contained; locally an
// already-running preview is reused instead of rebuilding.
export default defineConfig({
  testDir: "./e2e",
  // Measured on a 4-vCPU runner (the GitHub default) with the software
  // renderer, over a 24-test subset: 1 worker 259 s, 3 workers 192 s, 6 workers
  // 165 s, 10 workers 164 s. The speedup is sublinear because SwiftShader is
  // CPU-bound, and at 10 workers contention started failing tests that pass
  // serially. 3 is the conservative point on that curve.
  //
  // Local runs stay serial: dev machines have far more cores, so Playwright's
  // default (half of them) would oversubscribe well past where those flakes
  // began. Pass `--workers=N` to override either way.
  workers: process.env.CI ? 3 : 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    // Seed the first-launch UI-profile onboarding (issue #500) as already
    // completed. Otherwise its modal wizard opens on every fresh context and its
    // overlay intercepts pointer events, timing out any spec that clicks through
    // the UI. The partial blob is merged with defaults by the settings loader.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: BASE_URL,
          localStorage: [
            {
              name: DESKTOP_SETTINGS_STORAGE_KEY,
              value: JSON.stringify({ uiProfile: { onboarded: true } }),
            },
          ],
        },
      ],
    },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },
  // The two projects partition `e2e/` — nothing is listed twice, so a plain
  // `playwright test` still runs every spec exactly once. CI narrows to the
  // per-commit gate with `--project=core`.
  projects: [
    { name: "core", testMatch: coreMatch, use: chromium },
    { name: "features", testIgnore: coreMatch, use: chromium },
  ],
  webServer: {
    command: `npm run build && npm run preview -w geolibre-desktop -- --port ${PORT} --strictPort`,
    // Build without a Cesium Ion token from the shell. `vite.config.ts` bakes
    // `CESIUM_TOKEN`/`VITE_CESIUM_TOKEN` into the bundle, so a machine with one
    // exported would produce a *different* app than CI builds: the 3D globe
    // would come up with Ion terrain and imagery, and `cesium-globe.spec.ts`
    // could no longer tell the keyless path from the tokened one.
    //
    // This covers the shell only. The bridge in `vite.config.ts` falls through
    // to `loadEnv()` when the prefixed name is falsy, so a token in
    // `apps/geolibre-desktop/.env.local` is still picked up despite these being
    // blanked. That case is not silently tolerated — `cesium-globe.spec.ts`
    // asserts the tokenless hint and fails with a message naming the file.
    env: { CESIUM_TOKEN: "", VITE_CESIUM_TOKEN: "" },
    url: BASE_URL,
    // Reuse locally (the repo's existing DX trade-off), never in CI. Note the
    // interaction with `env` above: Playwright skips the whole command when it
    // reuses a server, so the override is *not* applied to a reused one. That
    // is why `cesium-globe.spec.ts` asserts the tokenless hint rather than
    // trusting this — a reused tokened build fails there with an explanation
    // instead of silently exercising the wrong path. In CI, where determinism
    // actually matters, this is false and the override always applies.
    reuseExistingServer: !process.env.CI,
    // The build (tsc -b + vite build) runs as part of this command, so allow
    // generous startup time on cold CI runners.
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
