import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";

// The hosted share.geolibre.app has no share-link management or
// organization/group membership API, so opening Project > Share there answers
// GET /api/shares, /api/groups/mine and /api/organizations/mine with 404. The
// dialog already treats those as "not available"; these tests pin that the
// Diagnostics panel does too, instead of recording three HTTP errors.

// diagnostics.ts reads localStorage at import time, so the window stub must be
// in place before the module loads; hence the dynamic imports below.
const forwarded: { url: string; headers: Headers }[] = [];
let respond: (url: string) => Response = () => new Response(null, { status: 404 });
const win = {
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  // Stands in for the browser fetch that the Diagnostics wrapper patches.
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    forwarded.push({ url, headers: new Headers(init?.headers) });
    return respond(url);
  }) as typeof fetch,
  addEventListener: () => {},
  removeEventListener: () => {},
};
(globalThis as { window?: unknown }).window = win;

type Diagnostics = typeof import("../apps/geolibre-desktop/src/lib/diagnostics");
type Gallery = typeof import("../apps/geolibre-desktop/src/lib/share-gallery");
type Share = typeof import("../apps/geolibre-desktop/src/lib/share-geolibre");
let diagnostics: Diagnostics;
let gallery: Gallery;
let share: Share;

const BASE = "https://share.geolibre.app";
// The browser share fetch resolves `fetch` at call time, which is the
// Diagnostics-patched `window.fetch` once capture is installed.
const viaWindowFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  win.fetch(input, init)) as typeof fetch;

let uninstall: (() => void) | null = null;

before(async () => {
  diagnostics = await import("../apps/geolibre-desktop/src/lib/diagnostics");
  gallery = await import("../apps/geolibre-desktop/src/lib/share-gallery");
  share = await import("../apps/geolibre-desktop/src/lib/share-geolibre");
});

beforeEach(() => {
  forwarded.length = 0;
  respond = () => new Response(null, { status: 404, statusText: "Not Found" });
  diagnostics.clearDiagnostics();
  diagnostics.setCaptureNetworkInfo(true);
  uninstall = diagnostics.installDiagnosticsCapture();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
});

function networkRecords() {
  return diagnostics.getDiagnosticsSnapshot().records.filter((r) => r.category === "network");
}

describe("share server optional routes", () => {
  it("treats a 404 from the membership routes as no memberships, not an error", async () => {
    const options = { token: "glb_tok", baseUrl: BASE, fetchImpl: viaWindowFetch };
    assert.deepEqual(await gallery.fetchMyOrganizations(options), []);
    assert.deepEqual(await gallery.fetchMyGroups(options), []);

    // Diagnostics lists records newest first.
    assert.deepEqual(
      networkRecords().map((r) => [r.url, r.status, r.level]),
      [
        [`${BASE}/api/groups/mine`, 404, "info"],
        [`${BASE}/api/organizations/mine`, 404, "info"],
      ],
    );
  });

  it("records the share-link listing's 404 as info while still reporting it unsupported", async () => {
    await assert.rejects(
      share.fetchProjectShares({ token: "glb_tok", baseUrl: BASE, fetchImpl: viaWindowFetch }),
      (error: unknown) => error instanceof share.ShareLinksUnsupportedError,
    );
    assert.deepEqual(
      networkRecords().map((r) => [r.url, r.status, r.level]),
      [[`${BASE}/api/shares`, 404, "info"]],
    );
  });

  it("never sends the client-only marker to the server", async () => {
    const options = { token: "glb_tok", baseUrl: BASE, fetchImpl: viaWindowFetch };
    await gallery.fetchMyGroups(options);
    await share.fetchProjectShares(options).catch(() => {});
    assert.equal(forwarded.length, 2);
    for (const request of forwarded) {
      assert.equal(request.headers.get(diagnostics.EXPECTED_STATUS_HEADER), null);
      assert.equal(request.headers.get("Authorization"), "Bearer glb_tok");
    }
  });

  it("still reports other failures of those routes as errors", async () => {
    respond = () => new Response(null, { status: 500, statusText: "Server Error" });
    const options = { token: "glb_tok", baseUrl: BASE, fetchImpl: viaWindowFetch };
    await assert.rejects(gallery.fetchMyGroups(options), (error: unknown) => {
      return error instanceof gallery.GalleryError && error.code === "http";
    });
    await assert.rejects(share.fetchProjectShares(options), /HTTP 500/);
    assert.deepEqual(
      networkRecords().map((r) => r.level),
      ["error", "error"],
    );
  });

  it("keeps a 404 an error on routes that are not optional", async () => {
    // GET /api/users/me exists on every share server; a 404 there is a fault.
    await assert.rejects(
      gallery.fetchMyShareUsername({ token: "glb_tok", baseUrl: BASE, fetchImpl: viaWindowFetch }),
    );
    assert.deepEqual(
      networkRecords().map((r) => [r.status, r.level]),
      [[404, "error"]],
    );
  });
});
