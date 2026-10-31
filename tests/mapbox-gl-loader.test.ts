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
  resetMapboxGlForTests,
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
  integrity?: string;
  crossOrigin?: string;
  textContent?: string;
  fire: (event: string) => void;
  addEventListener: (event: string, listener: () => void) => void;
  remove: () => void;
};

const testGlobals = globalThis as unknown as {
  document?: unknown;
  mapboxgl?: unknown;
  __NO_EXTERNAL_CDN__?: boolean;
};
const realFetch = globalThis.fetch;

/** Install a fake document and return the elements appended to its head. */
function installDocument(): FakeElement[] {
  const appended: FakeElement[] = [];
  testGlobals.document = {
    createElement: () => {
      const listeners = new Map<string, () => void>();
      const element: FakeElement = {
        fire: (event) => listeners.get(event)?.(),
        addEventListener: (event, listener) => listeners.set(event, listener),
        remove: () => {
          const index = appended.indexOf(element);
          if (index !== -1) appended.splice(index, 1);
        },
      };
      return element;
    },
    head: { appendChild: (element: FakeElement) => appended.push(element) },
  };
  return appended;
}

afterEach(() => {
  resetMapboxGlForTests();
  delete testGlobals.document;
  delete testGlobals.mapboxgl;
  delete testGlobals.__NO_EXTERNAL_CDN__;
  globalThis.fetch = realFetch;
});

it("pins the CDN files to the exact installed package", () => {
  const { version } = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  assert.equal(MAPBOX_GL_VERSION, version, STALE);
  assert.equal(MAPBOX_GL_SCRIPT_INTEGRITY, sri("mapbox-gl.js"), STALE);
  assert.equal(MAPBOX_GL_STYLE_INTEGRITY, sri("mapbox-gl.css"), STALE);
});

it("needs no CSP style-src host: the stylesheet only uses data URIs", () => {
  const css = readFileSync(path.join(packageDir, "dist/mapbox-gl.css"), "utf8");
  const withoutDataUris = css.replace(/url\("data:[^"]*"\)/g, "");
  assert.notEqual(withoutDataUris, css);
  assert.ok(!withoutDataUris.includes("url("));
});

it("refuses to load from the CDN in a no-external-CDN build", async () => {
  const appended = installDocument();
  testGlobals.__NO_EXTERNAL_CDN__ = true;
  await assert.rejects(loadMapboxGl(), /disabled in this build/);
  assert.equal(appended.length, 0);
});

it("retries after a failed load, then shares one load between callers", async () => {
  const appended = installDocument();
  const fetches: Array<[unknown, RequestInit | undefined]> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    fetches.push([url, init]);
    return new Response("/* css */");
  }) as typeof fetch;

  const failed = loadMapboxGl();
  const [failedScript] = appended;
  failedScript!.fire("error");
  await assert.rejects(failed, /Could not load Mapbox GL JS/);
  assert.ok(!appended.includes(failedScript!));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches.length, 1);
  assert.equal(appended.at(-1)!.textContent, "/* css */");
  assert.equal(appended.length, 1);

  const retried = loadMapboxGl();
  assert.equal(loadMapboxGl(), retried);
  const script = appended.at(-1);
  assert.equal(script!.src, MAPBOX_GL_SCRIPT_URL);
  assert.equal(script!.integrity, MAPBOX_GL_SCRIPT_INTEGRITY);
  assert.equal(script!.crossOrigin, "anonymous");
  const namespace = { Map: class {} };
  testGlobals.mapboxgl = namespace;
  script!.fire("load");
  assert.equal(await retried, namespace);
  assert.deepEqual(fetches, [[MAPBOX_GL_STYLE_URL, { integrity: MAPBOX_GL_STYLE_INTEGRITY }]]);
});

it("retries only the stylesheet when the script already loaded", async () => {
  const appended = installDocument();
  let status = 503;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return new Response("/* css */", { status });
  }) as typeof fetch;

  const failed = loadMapboxGl();
  const [script] = appended;
  script!.fire("load");
  await assert.rejects(failed, /HTTP 503/);

  status = 200;
  const namespace = { Map: class {} };
  testGlobals.mapboxgl = namespace;
  assert.equal(await loadMapboxGl(), namespace);
  assert.equal(fetchCount, 2);
  assert.deepEqual(appended[0], script);
  assert.equal(appended.length, 2);
  assert.equal(appended[1]!.textContent, "/* css */");
});

it("reloads a script that ran without defining the namespace", async () => {
  const appended = installDocument();
  globalThis.fetch = (async () => new Response("/* css */")) as typeof fetch;

  const failed = loadMapboxGl();
  appended[0]!.fire("load");
  await assert.rejects(failed, /did not define/);

  const retried = loadMapboxGl();
  const scripts = appended.filter((element) => element.src);
  assert.equal(scripts.length, 2);
  const namespace = { Map: class {} };
  testGlobals.mapboxgl = namespace;
  scripts[1]!.fire("load");
  assert.equal(await retried, namespace);
});
