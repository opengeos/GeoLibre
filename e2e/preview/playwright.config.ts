import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "../../apps/geolibre-desktop/src/lib/storage-keys";

// Anchor reports at the repo root, where CI uploads them from (as in
// e2e/enterprise-sso/playwright.config.ts).
const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * Smoke test for an already-deployed copy of the web app: the PR previews, or
 * any other host. Point `PREVIEW_URL` at the app itself (for the previews, the
 * `/demo/` page) and it checks the map renders with a clean console. Nothing is
 * built or served here, unlike the default suites, which is why it has its own
 * config and the default `playwright.config.ts` ignores `e2e/preview/`.
 *
 * Run by the `smoke` job in .github/workflows/pr-preview-deploy.yml; locally:
 *   PREVIEW_URL=https://<id>.geolibre-preview.pages.dev/demo/ npm run test:e2e:preview
 */
const PREVIEW_URL = process.env.PREVIEW_URL;
if (!PREVIEW_URL) throw new Error("Set PREVIEW_URL to the deployed app's URL.");
const BASE_URL = PREVIEW_URL.endsWith("/") ? PREVIEW_URL : `${PREVIEW_URL}/`;

export default defineConfig({
  testDir: ".",
  outputDir: path.join(REPO_ROOT, "test-results"),
  workers: 1,
  forbidOnly: !!process.env.CI,
  // A fresh deploy can take a moment to propagate across Cloudflare's edge.
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [
        ["list"],
        ["html", { open: "never", outputFolder: path.join(REPO_ROOT, "playwright-report") }],
      ]
    : [["list"]],
  use: {
    baseURL: BASE_URL,
    // Skip the first-launch onboarding wizard, as in playwright.config.ts.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: new URL(BASE_URL).origin,
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
    // Same software-WebGL Chromium as the default suites (see playwright.config.ts).
    ...devices["Desktop Chrome"],
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader"] },
  },
});
