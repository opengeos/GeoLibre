import { defineConfig, devices } from "@playwright/test";

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
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: BASE_URL,
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
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    // The build (tsc -b + vite build) runs as part of this command, so allow
    // generous startup time on cold CI runners.
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
