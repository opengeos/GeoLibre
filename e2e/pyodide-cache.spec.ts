import { expect, test, type Page } from "./test";
import { PYODIDE_VERSION } from "../apps/geolibre-desktop/src/lib/pyodide/pyodide-config";

const ASM_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/pyodide.asm.js`;
const ENGINE_CACHE = "geolibre-cdn-engines";

async function waitForServiceWorker(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

async function expectModuleLoads(page: Page): Promise<void> {
  expect(
    await page.evaluate(async (url) => {
      await import(/* @vite-ignore */ url);
      return true;
    }, ASM_URL),
  ).toBe(true);
}

test("classic worker and console imports share CORS-readable offline engine assets", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await waitForServiceWorker(page);
  const workerResult = await page.evaluate(async (url) => {
    const source = `try { importScripts(${JSON.stringify(url)}); postMessage("loaded"); } catch (error) { postMessage(String(error)); }`;
    const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(blobUrl);
    try {
      return await new Promise<string>((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => reject(new Error(event.message));
      });
    } finally {
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
    }
  }, ASM_URL);
  expect(workerResult).toBe("loaded");
  await expect
    .poll(() =>
      page.evaluate(
        async ({ url, cacheName }) => {
          const response = await (await caches.open(cacheName)).match(url);
          return { type: response?.type, status: response?.status };
        },
        { url: ASM_URL, cacheName: ENGINE_CACHE },
      ),
    )
    .toEqual({ type: "cors", status: 200 });
  await expectModuleLoads(page);

  await context.setOffline(true);
  try {
    const status = await page.evaluate(async (url) => {
      const response = await fetch(url, { mode: "cors" });
      return response.status;
    }, ASM_URL);
    expect(status).toBe(200);
  } finally {
    await context.setOffline(false);
  }
});

test("a legacy opaque engine entry is replaced without clearing other cached engines", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await waitForServiceWorker(page);
  const seededType = await page.evaluate(
    async ({ url, cacheName, version }) => {
      // This npm path is outside the engine rule. A real no-cors response models
      // the opaque entry left by the old worker without faking browser semantics.
      const opaque = await fetch(`https://cdn.jsdelivr.net/npm/pyodide@${version}/README.md`, {
        mode: "no-cors",
      });
      const cache = await caches.open(cacheName);
      await cache.put(url, opaque);
      await cache.put(`${location.origin}/cached-engine-sentinel`, new Response("keep"));
      return (await cache.match(url))?.type;
    },
    { url: ASM_URL, cacheName: ENGINE_CACHE, version: PYODIDE_VERSION },
  );
  expect(seededType).toBe("opaque");
  await expectModuleLoads(page);
  await expect
    .poll(() =>
      page.evaluate(
        async ({ url, cacheName }) => {
          const cache = await caches.open(cacheName);
          return {
            status: (await cache.match(url))?.status,
            sentinel: await (
              await cache.match(`${location.origin}/cached-engine-sentinel`)
            )?.text(),
          };
        },
        { url: ASM_URL, cacheName: ENGINE_CACHE },
      ),
    )
    .toEqual({ status: 200, sentinel: "keep" });
});
