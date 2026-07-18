import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchMyProjects,
  fetchSharedProjects,
  GalleryError,
  projectOpenToken,
  resolveThumbnailUrl,
  shareAuthorizedFetch,
} from "../apps/geolibre-desktop/src/lib/share-gallery";

const BASE = "https://share.geolibre.app";

function rawProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "abc-123",
    username: "giswqs",
    slug: "my-map",
    title: "My Map",
    description: "",
    visibility: "public",
    thumbnailUrl: "/api/thumbnails/abc-123?v=1",
    views: 7,
    forkCount: 0,
    versionCount: 1,
    featured: false,
    createdAt: "2026-06-23T15:48:15.000Z",
    updatedAt: "2026-06-23T15:48:15.000Z",
    tags: ["water", "ocean"],
    rawJsonUrl: `${BASE}/giswqs/my-map.geolibre.json`,
    projectUrl: `${BASE}/giswqs/my-map`,
    viewerUrl: `https://web.geolibre.app/?url=${BASE}/giswqs/my-map.geolibre.json`,
    ...overrides,
  };
}

function fakeFetch(status: number, body: unknown): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("resolveThumbnailUrl", () => {
  it("resolves a site-relative path against the base host", () => {
    assert.equal(resolveThumbnailUrl("/api/thumbnails/x", BASE), `${BASE}/api/thumbnails/x`);
  });

  it("passes through an already-absolute URL", () => {
    assert.equal(
      resolveThumbnailUrl("https://cdn.example.com/t.png", BASE),
      "https://cdn.example.com/t.png",
    );
  });

  it("returns null for empty or non-string values", () => {
    assert.equal(resolveThumbnailUrl("", BASE), null);
    assert.equal(resolveThumbnailUrl(null, BASE), null);
    assert.equal(resolveThumbnailUrl(undefined, BASE), null);
  });
});

describe("fetchSharedProjects", () => {
  it("normalizes records and resolves the thumbnail URL", async () => {
    const { fn } = fakeFetch(200, { projects: [rawProject()] });
    const { projects } = await fetchSharedProjects({
      baseUrl: BASE,
      fetchImpl: fn,
    });
    assert.equal(projects.length, 1);
    assert.equal(projects[0].title, "My Map");
    assert.equal(projects[0].views, 7);
    assert.deepEqual(projects[0].tags, ["water", "ocean"]);
    assert.equal(projects[0].thumbnailUrl, `${BASE}/api/thumbnails/abc-123?v=1`);
  });

  it("sends limit and offset as query params", async () => {
    const { fn, calls } = fakeFetch(200, { projects: [] });
    await fetchSharedProjects({
      baseUrl: BASE,
      limit: 24,
      offset: 48,
      fetchImpl: fn,
    });
    assert.match(calls[0], /\/api\/projects\?/);
    assert.match(calls[0], /limit=24/);
    assert.match(calls[0], /offset=48/);
  });

  it("omits offset=0 from the query", async () => {
    const { fn, calls } = fakeFetch(200, { projects: [] });
    await fetchSharedProjects({ baseUrl: BASE, limit: 10, fetchImpl: fn });
    assert.ok(!calls[0].includes("offset="));
  });

  it("adds featured=true only when requested", async () => {
    const plain = fakeFetch(200, { projects: [] });
    await fetchSharedProjects({ baseUrl: BASE, limit: 10, fetchImpl: plain.fn });
    assert.ok(!plain.calls[0].includes("featured"));

    const feat = fakeFetch(200, { projects: [] });
    await fetchSharedProjects({
      baseUrl: BASE,
      limit: 10,
      featured: true,
      fetchImpl: feat.fn,
    });
    assert.match(feat.calls[0], /featured=true/);
  });

  it("reports hasMore when a full page is returned", async () => {
    const full = Array.from({ length: 3 }, (_, i) => rawProject({ id: `id-${i}` }));
    const { fn } = fakeFetch(200, { projects: full });
    const result = await fetchSharedProjects({
      baseUrl: BASE,
      limit: 3,
      fetchImpl: fn,
    });
    assert.equal(result.hasMore, true);
  });

  it("reports no more when the page is short", async () => {
    const { fn } = fakeFetch(200, { projects: [rawProject()] });
    const result = await fetchSharedProjects({
      baseUrl: BASE,
      limit: 3,
      fetchImpl: fn,
    });
    assert.equal(result.hasMore, false);
  });

  it("drops records missing an id or rawJsonUrl", async () => {
    const { fn } = fakeFetch(200, {
      projects: [
        rawProject(),
        rawProject({ id: "", slug: "no-id" }),
        rawProject({ rawJsonUrl: "" }),
      ],
    });
    const { projects } = await fetchSharedProjects({
      baseUrl: BASE,
      fetchImpl: fn,
    });
    assert.equal(projects.length, 1);
  });

  it("returns an empty list when the payload has no projects array", async () => {
    const { fn } = fakeFetch(200, {});
    const { projects } = await fetchSharedProjects({
      baseUrl: BASE,
      fetchImpl: fn,
    });
    assert.deepEqual(projects, []);
  });

  it("throws a coded GalleryError on a non-2xx response", async () => {
    const { fn } = fakeFetch(500, null);
    await assert.rejects(
      () => fetchSharedProjects({ baseUrl: BASE, fetchImpl: fn }),
      (err: unknown) => err instanceof GalleryError && err.code === "http" && err.status === 500,
    );
  });

  it("throws an 'invalid-response' GalleryError when the body is not JSON", async () => {
    // A 200 whose json() rejects (e.g. an HTML error page) must surface as a
    // retryable error, not an empty gallery.
    const fn = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      }) as Response) as unknown as typeof fetch;
    await assert.rejects(
      () => fetchSharedProjects({ baseUrl: BASE, fetchImpl: fn }),
      (err: unknown) => err instanceof GalleryError && err.code === "invalid-response",
    );
  });

  it("reports rawCount alongside the normalized projects", async () => {
    const { fn } = fakeFetch(200, {
      projects: [rawProject(), rawProject({ id: "", slug: "dropped" })],
    });
    const result = await fetchSharedProjects({
      baseUrl: BASE,
      limit: 24,
      fetchImpl: fn,
    });
    // One record was dropped by normalization, but rawCount reflects the two
    // the server actually returned (so the next offset stays correct).
    assert.equal(result.projects.length, 1);
    assert.equal(result.rawCount, 2);
  });
});

// A routing fake: maps a URL path to a {status, body} response and records the
// Authorization header each call carried.
function routedFetch(routes: Record<string, { status: number; body: unknown }>): {
  fn: typeof fetch;
  auth: (string | null)[];
} {
  const auth: (string | null)[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const headers = new Headers(init.headers);
    auth.push(headers.get("Authorization"));
    const route = routes[path] ?? { status: 404, body: null };
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, auth };
}

describe("fetchMyProjects", () => {
  it("resolves the username then lists the owner's projects with the token", async () => {
    const { fn, auth } = routedFetch({
      "/api/users/me": { status: 200, body: { user: { username: "giswqs" } } },
      "/api/users/giswqs/projects": {
        status: 200,
        body: {
          projects: [
            rawProject({ id: "p1", visibility: "private", slug: "secret" }),
            rawProject({ id: "p2", visibility: "unlisted", slug: "draft" }),
          ],
        },
      },
    });
    const projects = await fetchMyProjects({
      token: "glb_tok",
      baseUrl: BASE,
      fetchImpl: fn,
    });
    assert.equal(projects.length, 2);
    assert.deepEqual(
      projects.map((p) => p.visibility),
      ["private", "unlisted"],
    );
    // Every request carried the bearer token.
    assert.ok(auth.every((a) => a === "Bearer glb_tok"));
  });

  it("throws a 'username-required' GalleryError when the account has no username", async () => {
    const { fn } = routedFetch({
      "/api/users/me": { status: 200, body: { user: { username: null } } },
    });
    await assert.rejects(
      () => fetchMyProjects({ token: "glb_tok", baseUrl: BASE, fetchImpl: fn }),
      (err: unknown) => err instanceof GalleryError && err.code === "username-required",
    );
  });

  it("throws an 'unauthorized' GalleryError when the token is rejected", async () => {
    const { fn } = routedFetch({
      "/api/users/me": { status: 401, body: { error: "Unauthorized" } },
    });
    await assert.rejects(
      () => fetchMyProjects({ token: "bad", baseUrl: BASE, fetchImpl: fn }),
      (err: unknown) => err instanceof GalleryError && err.code === "unauthorized",
    );
  });
});

describe("shareAuthorizedFetch", () => {
  it("attaches the token only for the share host, never third parties", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : String(input);
      seen.push({ url, auth: new Headers(init.headers).get("Authorization") });
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    try {
      const authed = shareAuthorizedFetch("glb_tok", BASE);
      await authed(`${BASE}/giswqs/secret.geolibre.json`);
      await authed("https://tiles.example.com/data.json");
      assert.equal(seen[0].auth, "Bearer glb_tok");
      assert.equal(seen[1].auth, null);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("projectOpenToken", () => {
  // Attaching Authorization to a public or unlisted raw .geolibre.json is not a
  // harmless extra: it makes the request CORS-preflighted, and the share host
  // 404s OPTIONS on raw project paths, so the browser blocks the open. Every
  // gallery card failed to open this way.
  for (const visibility of ["public", "unlisted"]) {
    it(`sends no token for ${visibility} projects, which need no auth`, () => {
      assert.equal(projectOpenToken({ visibility }, "glb_tok"), undefined);
    });
  }

  it("sends the token for private projects, which are owner-only", () => {
    assert.equal(projectOpenToken({ visibility: "private" }, "glb_tok"), "glb_tok");
  });

  it("sends nothing when there is no token to send", () => {
    assert.equal(projectOpenToken({ visibility: "private" }, ""), undefined);
  });
});
