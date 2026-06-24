import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchSharedProjects,
  resolveThumbnailUrl,
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
    viewerUrl: `https://viewer.geolibre.app/?url=${BASE}/giswqs/my-map.geolibre.json`,
    ...overrides,
  };
}

function fakeFetch(
  status: number,
  body: unknown,
): { fn: typeof fetch; calls: string[] } {
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
    assert.equal(
      resolveThumbnailUrl("/api/thumbnails/x", BASE),
      `${BASE}/api/thumbnails/x`,
    );
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
    assert.equal(
      projects[0].thumbnailUrl,
      `${BASE}/api/thumbnails/abc-123?v=1`,
    );
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

  it("reports hasMore when a full page is returned", async () => {
    const full = Array.from({ length: 3 }, (_, i) =>
      rawProject({ id: `id-${i}` }),
    );
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

  it("throws a descriptive error on a non-2xx response", async () => {
    const { fn } = fakeFetch(500, null);
    await assert.rejects(
      () => fetchSharedProjects({ baseUrl: BASE, fetchImpl: fn }),
      /HTTP 500/,
    );
  });
});
