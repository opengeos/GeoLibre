import "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";

const { config } = await import("maplibre-gl");
const { mbtilesTileUrl, registerMbtilesProtocol } =
  await import("../apps/geolibre-desktop/src/lib/mbtiles");
const { BROWSER_MBTILES_KEY_PREFIX } =
  await import("../apps/geolibre-desktop/src/lib/mbtiles-sqljs");
registerMbtilesProtocol();
const handler = config.REGISTERED_PROTOCOLS["geolibre-mbtiles"];
assert.ok(handler);
const originalURL = globalThis.URL;
const previousTauri = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
const calls: { command: string; args: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  // Match the observed Android WebView 124 behavior for non-special schemes.
  globalThis.URL = new Proxy(originalURL, {
    construct(target, args, newTarget) {
      const parsed: URL = Reflect.construct(target, args, newTarget);
      if (String(args[0]).startsWith("geolibre-mbtiles:")) {
        Object.defineProperties(parsed, {
          pathname: { value: `//${parsed.host}${parsed.pathname}` },
          host: { value: "" },
          hostname: { value: "" },
        });
      }
      return parsed;
    },
  });
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (command: string, args: unknown) => {
        calls.push({ command, args });
        return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
      },
    },
  });
});

afterEach(() => {
  globalThis.URL = originalURL;
  if (previousTauri) Object.defineProperty(window, "__TAURI_INTERNALS__", previousTauri);
  else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

it("routes an encoded managed path and XYZ coordinates on legacy Android URL implementations", async () => {
  const path = "/data/user/0/org.geolibre.app/files/picked-documents/map % # é.mbtiles";
  const url = mbtilesTileUrl(path).replace("{z}/{x}/{y}", "19/84092/202470");
  const response = await handler({ url }, new AbortController());
  assert.deepEqual(calls, [
    { command: "read_mbtiles_tile", args: { path, z: 19, x: 84092, y: 202470 } },
  ]);
  assert.ok(response.data instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(response.data)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

it("rejects malformed coordinates and missing paths before native I/O", async () => {
  for (const url of [
    "geolibre-mbtiles://tile/1/2?path=x.mbtiles",
    "geolibre-mbtiles://tile/1/-2/3?path=x.mbtiles",
    "geolibre-mbtiles://tile/1/2.5/3?path=x.mbtiles",
    "geolibre-mbtiles://tile/1/2/3",
  ])
    await assert.rejects(handler({ url }, new AbortController()), /Invalid MBTiles/);
  assert.deepEqual(calls, []);
});

it("preserves the expired browser archive error without falling back to native reads", async () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  const url = mbtilesTileUrl(`${BROWSER_MBTILES_KEY_PREFIX}expired/1/map.mbtiles`).replace(
    "{z}/{x}/{y}",
    "1/0/0",
  );
  await assert.rejects(handler({ url }, new AbortController()), /no longer loaded/);
  assert.deepEqual(calls, []);
});
