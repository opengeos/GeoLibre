import { defineConfig, devices } from "@playwright/test";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "./apps/geolibre-desktop/src/lib/storage-keys";

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

// End-to-end smoke tests run against the *built* web app served by `vite
// preview` (matching production output), not the dev server. The webServer
// command builds first so the suite is self-contained; locally an
// already-running preview is reused instead of rebuilding.
export default defineConfig({
  testDir: "./e2e",
  // One small smoke file driving a single shared server — keep it serial.
  workers: 1,
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
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          // MapLibre needs a WebGL context; force software ANGLE/SwiftShader so
          // the map initializes on headless CI runners without a real GPU.
          args: ["--use-gl=angle", "--use-angle=swiftshader"],
        },
      },
    },
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
