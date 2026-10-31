import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, it } from "node:test";
import {
  loadMapboxGl,
  MAPBOX_GL_SCRIPT_INTEGRITY,
  MAPBOX_GL_SCRIPT_URL,
  MAPBOX_GL_STYLE_INTEGRITY,
  MAPBOX_GL_STYLE_URL,
  MAPBOX_GL_VERSION,
} from "../packages/map/src/mapbox-gl-loader";

const require = createRequire(path.resolve("packages/map/package.json"));
const packageDir = path.dirname(require.resolve("mapbox-gl/package.json"));
const STALE = "stale Mapbox GL pin: see 'mapbox-gl' in docs/maintenance.md";

const sri = (file: string): string =>
  `sha384-${createHash("sha384")
    .update(readFileSync(path.join(packageDir, "dist", file)))
    .digest("base64")}`;

type FakeElement = {
  src?: string;
  href?: string;
  integrity?: string;
  crossOrigin?: string;
  fire: (event: string) => void;
  addEventListener: (event: string, listener: () => void) => void;
  remove: () => void;
};

/** Install a fake document and return the elements appended to its head. */
function installDocument(): FakeElement[] {
  const appended: FakeElement[] = [];
  (globalThis as { document?: unknown }).document = {
    createElement: () => {
      const listeners = new Map<string, () => void>();
      const element: FakeElement = {
        fire: (event) => listeners.get(event)?.(),
        addEventListener: (event, listener) => listeners.set(event, listener),
        remove: () => appended.splice(appended.indexOf(element), 1),
      };
      return element;
    },
    head: { appendChild: (element: FakeElement) => appended.push(element) },
  };
  return appended;
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { mapboxgl?: unknown }).mapboxgl;
});

it("pins the CDN files to the exact installed package", () => {
  const { version } = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  assert.equal(MAPBOX_GL_VERSION, version, STALE);
  assert.equal(MAPBOX_GL_SCRIPT_INTEGRITY, sri("mapbox-gl.js"), STALE);
  assert.equal(MAPBOX_GL_STYLE_INTEGRITY, sri("mapbox-gl.css"), STALE);
});

it("retries after a failed load, then shares one load between callers", async () => {
  const appended = installDocument();
  const failed = loadMapboxGl();
  assert.equal(appended.length, 2);
  appended[0]!.fire("error");
  await assert.rejects(failed, /Could not load Mapbox GL JS/);
  assert.equal(appended.length, 0);

  const retried = loadMapboxGl();
  assert.equal(loadMapboxGl(), retried);
  assert.equal(appended.length, 2);
  const [script, style] = appended;
  assert.equal(script!.src, MAPBOX_GL_SCRIPT_URL);
  assert.equal(script!.integrity, MAPBOX_GL_SCRIPT_INTEGRITY);
  assert.equal(script!.crossOrigin, "anonymous");
  assert.equal(style!.href, MAPBOX_GL_STYLE_URL);
  assert.equal(style!.integrity, MAPBOX_GL_STYLE_INTEGRITY);
  const namespace = { Map: class {} };
  (globalThis as { mapboxgl?: unknown }).mapboxgl = namespace;
  script!.fire("load");
  style!.fire("load");
  assert.equal(await retried, namespace);
});
