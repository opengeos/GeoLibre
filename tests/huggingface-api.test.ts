import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildBlobViewUrl,
  buildDownloadUrl,
  buildResolveUrl,
  buildTreeViewUrl,
  bytesToBase64,
  canRenderFrom,
  createDatasetRepo,
  datasetUrl,
  fetchDataset,
  HF_MAX_UPLOAD_BYTES,
  HF_MAX_UPLOAD_TOTAL_BYTES,
  HF_SITE,
  isOwnerName,
  listDatasetTree,
  listOwnerDatasets,
  parseDataset,
  parseDatasetList,
  parseNextCursor,
  parseRepoId,
  parseTree,
  searchDatasets,
  sha256Hex,
  synthesizeDataset,
  uploadDatasetFiles,
  whoAmI,
  type HfDataset,
  type HfFetch,
  type HfRequestInit,
} from "../packages/plugins/src/plugins/huggingface-api";

/** One request a stub recorded, enough to assert on URL, headers, and body. */
interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A fetch stub that answers each request from a route table, matched by the
 * first table key the URL contains. Records every call for assertions.
 */
function stubFetch(
  routes: { match: string; body: string; ok?: boolean; status?: number; link?: string }[],
): { fetchImpl: HfFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: HfFetch = async (url: string, init?: HfRequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) throw new Error(`No stub route for ${url}`);
    return {
      ok: route.ok ?? true,
      status: route.status ?? 200,
      text: async () => route.body,
      headers: {
        get: (name: string) => (name.toLowerCase() === "link" ? (route.link ?? null) : null),
      },
    };
  };
  return { fetchImpl, calls };
}

/** A raw `/api/datasets` record, close to the real API shape. */
function rawDataset(overrides: Record<string, unknown> = {}) {
  return {
    _id: "67c3d202fa4955473c8a1bb4",
    id: "giswqs/geospatial",
    author: "giswqs",
    disabled: false,
    gated: false,
    private: false,
    likes: 2,
    downloads: 10464,
    lastModified: "2026-03-11T14:33:21.000Z",
    tags: ["license:mit", "format:imagefolder", "modality:image", "region:us"],
    ...overrides,
  };
}

describe("parseRepoId", () => {
  it("splits an owner/name id", () => {
    assert.deepEqual(parseRepoId("giswqs/geospatial"), {
      owner: "giswqs",
      name: "geospatial",
    });
  });

  it("tolerates surrounding whitespace and a trailing slash", () => {
    assert.deepEqual(parseRepoId("  giswqs/geospatial/  "), {
      owner: "giswqs",
      name: "geospatial",
    });
  });

  it("rejects a bare account name, which is not a repo id", () => {
    assert.equal(parseRepoId("giswqs"), null);
  });

  it("rejects a three-segment path", () => {
    assert.equal(parseRepoId("giswqs/geospatial/extra"), null);
  });

  it("rejects free text", () => {
    assert.equal(parseRepoId("land cover data"), null);
  });
});

describe("isOwnerName", () => {
  it("accepts the characters Hugging Face allows in an account name", () => {
    assert.equal(isOwnerName("giswqs"), true);
    assert.equal(isOwnerName("open-geo.labs_1"), true);
  });

  it("rejects anything with a slash or a space", () => {
    assert.equal(isOwnerName("giswqs/geospatial"), false);
    assert.equal(isOwnerName("land cover"), false);
  });
});

describe("buildResolveUrl", () => {
  it("builds a resolve URL on the default revision", () => {
    assert.equal(
      buildResolveUrl("giswqs/geospatial", "landsat/1984.tif"),
      `${HF_SITE}/datasets/giswqs/geospatial/resolve/main/landsat/1984.tif`,
    );
  });

  it("keeps the owner/name slash intact rather than encoding it", () => {
    const url = buildResolveUrl("giswqs/geospatial", "a.tif");
    assert.ok(!url.includes("%2F"), url);
  });

  it("encodes each path segment separately, so folder slashes survive", () => {
    // Hive-partitioned datasets are common, and the `=` must reach the server.
    const url = buildResolveUrl("owner/repo", "country=AFG/AFG.pmtiles");
    assert.equal(url, `${HF_SITE}/datasets/owner/repo/resolve/main/country%3DAFG/AFG.pmtiles`);
  });

  it("honours a non-default revision", () => {
    assert.equal(
      buildResolveUrl("owner/repo", "a.tif", "v1.0"),
      `${HF_SITE}/datasets/owner/repo/resolve/v1.0/a.tif`,
    );
  });
});

describe("buildDownloadUrl", () => {
  it("adds the flag that makes the Hub send Content-Disposition: attachment", () => {
    assert.equal(
      buildDownloadUrl(`${HF_SITE}/datasets/o/r/resolve/main/a.csv`),
      `${HF_SITE}/datasets/o/r/resolve/main/a.csv?download=true`,
    );
  });

  it("appends to an existing query string instead of starting a second one", () => {
    assert.equal(buildDownloadUrl("https://x/y?a=1"), "https://x/y?a=1&download=true");
  });
});

describe("datasetUrl", () => {
  it("points at the repo's page, not its data", () => {
    assert.equal(datasetUrl("giswqs/geospatial"), `${HF_SITE}/datasets/giswqs/geospatial`);
  });
});

describe("parseDataset", () => {
  it("normalizes a record into owner, name, and stats", () => {
    const dataset = parseDataset(rawDataset());
    assert.ok(dataset);
    assert.equal(dataset.id, "giswqs/geospatial");
    assert.equal(dataset.owner, "giswqs");
    assert.equal(dataset.name, "geospatial");
    assert.equal(dataset.likes, 2);
    assert.equal(dataset.downloads, 10464);
    assert.equal(dataset.lastModified, "2026-03-11T14:33:21.000Z");
    assert.equal(dataset.url, `${HF_SITE}/datasets/giswqs/geospatial`);
  });

  it("rejects a record with no usable id", () => {
    assert.equal(parseDataset({ likes: 3 }), null);
    assert.equal(parseDataset({ id: "no-slash" }), null);
    assert.equal(parseDataset("not an object"), null);
  });

  it("drops a disabled repo, whose files only 403", () => {
    assert.equal(parseDataset(rawDataset({ disabled: true })), null);
  });

  it("treats the API's non-boolean `gated` values as gated", () => {
    // The API reports `false | "auto" | "manual"`, not a boolean.
    assert.equal(parseDataset(rawDataset({ gated: "auto" }))?.gated, true);
    assert.equal(parseDataset(rawDataset({ gated: "manual" }))?.gated, true);
    assert.equal(parseDataset(rawDataset({ gated: false }))?.gated, false);
  });

  it("keeps a private repo, which is listed but not renderable", () => {
    const dataset = parseDataset(rawDataset({ private: true }));
    assert.equal(dataset?.private, true);
  });

  it("keeps only string tags", () => {
    const dataset = parseDataset(rawDataset({ tags: ["a", 7, null, "b"] }));
    assert.deepEqual(dataset?.tags, ["a", "b"]);
  });

  it("defaults missing counters and timestamp rather than producing NaN", () => {
    const dataset = parseDataset({ id: "o/r" });
    assert.equal(dataset?.likes, 0);
    assert.equal(dataset?.downloads, 0);
    assert.equal(dataset?.lastModified, null);
    assert.deepEqual(dataset?.tags, []);
  });
});

describe("parseDatasetList", () => {
  it("reads the bare array the Hub returns", () => {
    assert.equal(parseDatasetList([rawDataset(), rawDataset({ id: "o/r" })]).length, 2);
  });

  it("also accepts a wrapped list", () => {
    assert.equal(parseDatasetList({ datasets: [rawDataset()] }).length, 1);
  });

  it("drops unusable records instead of failing the whole page", () => {
    assert.equal(parseDatasetList([rawDataset(), { junk: true }]).length, 1);
  });

  it("returns an empty list for a body that is not a list at all", () => {
    assert.deepEqual(parseDatasetList("<html>404</html>"), []);
  });
});

describe("parseTree", () => {
  const entries = [
    { type: "directory", oid: "79ae", size: 0, path: "landsat" },
    { type: "file", oid: "aca2", size: 10955, path: ".gitattributes" },
    {
      type: "file",
      oid: "a7c4",
      size: 19079696,
      lfs: { oid: "7ed8", size: 19079696, pointerSize: 133 },
      path: "chm.tif",
    },
  ];

  it("splits folders from files", () => {
    const listing = parseTree(entries, "giswqs/geospatial");
    assert.deepEqual(listing.folders, ["landsat"]);
    assert.deepEqual(
      listing.files.map((file) => file.name),
      [".gitattributes", "chm.tif"],
    );
  });

  it("classifies a file and builds its resolve URL", () => {
    const tif = parseTree(entries, "giswqs/geospatial").files[1];
    assert.equal(tif.format, "cog");
    assert.equal(tif.size, 19079696);
    assert.equal(tif.lfs, true);
    assert.equal(tif.url, `${HF_SITE}/datasets/giswqs/geospatial/resolve/main/chm.tif`);
  });

  it("reports the top-level size, which already holds the real LFS blob size", () => {
    const tif = parseTree(entries, "o/r").files[1];
    assert.equal(tif.size, 19079696);
  });

  it("keeps a subfolder entry's full repo-relative path", () => {
    const listing = parseTree(
      [{ type: "file", size: 5, path: "landsat/1984.tif" }],
      "giswqs/geospatial",
    );
    assert.equal(listing.files[0].path, "landsat/1984.tif");
    assert.equal(listing.files[0].name, "1984.tif");
  });

  it("carries a non-default revision into every file URL", () => {
    const listing = parseTree([{ type: "file", size: 1, path: "a.tif" }], "o/r", "dev");
    assert.equal(listing.files[0].url, `${HF_SITE}/datasets/o/r/resolve/dev/a.tif`);
  });

  it("ignores entries that are neither file nor directory", () => {
    const listing = parseTree([{ type: "submodule", path: "x" }], "o/r");
    assert.deepEqual(listing.files, []);
    assert.deepEqual(listing.folders, []);
  });

  it("returns an empty listing for a body that is not an array", () => {
    assert.deepEqual(parseTree({ error: "nope" }, "o/r"), { files: [], folders: [] });
  });
});

describe("parseNextCursor", () => {
  it("reads the cursor out of a rel=next Link header", () => {
    const header = `<https://huggingface.co/api/datasets/o/r/tree/main?limit=2&cursor=ZXlK>; rel="next"`;
    assert.equal(parseNextCursor(header), "ZXlK");
  });

  it("returns null when there is no next page", () => {
    assert.equal(parseNextCursor(null), null);
    assert.equal(parseNextCursor(undefined), null);
    assert.equal(parseNextCursor(`<https://x/y>; rel="prev"`), null);
  });

  it("returns null rather than throwing on a malformed header", () => {
    assert.equal(parseNextCursor(`<not a url>; rel="next"`), null);
  });
});

describe("canRenderFrom", () => {
  const base: HfDataset = {
    id: "o/r",
    owner: "o",
    name: "r",
    private: false,
    gated: false,
    likes: 0,
    downloads: 0,
    lastModified: null,
    tags: [],
    url: "https://x",
  };

  it("allows a public, ungated repo", () => {
    assert.equal(canRenderFrom(base), true);
  });

  it("blocks private and gated repos, whose files need an auth header", () => {
    assert.equal(canRenderFrom({ ...base, private: true }), false);
    assert.equal(canRenderFrom({ ...base, gated: true }), false);
  });
});

describe("listOwnerDatasets", () => {
  it("asks for the account's datasets, newest first", async () => {
    const { fetchImpl, calls } = stubFetch([{ match: "/datasets", body: "[]" }]);
    await listOwnerDatasets("giswqs", { fetchImpl });
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get("author"), "giswqs");
    assert.equal(url.searchParams.get("sort"), "lastModified");
    assert.equal(url.searchParams.get("direction"), "-1");
  });

  it("sends the token as a bearer header so private repos are listed too", async () => {
    const { fetchImpl, calls } = stubFetch([{ match: "/datasets", body: "[]" }]);
    await listOwnerDatasets("giswqs", { fetchImpl, token: "hf_secret" });
    assert.equal(calls[0].headers.Authorization, "Bearer hf_secret");
  });

  it("never puts the token in the URL, which would leak it into logs", async () => {
    const { fetchImpl, calls } = stubFetch([{ match: "/datasets", body: "[]" }]);
    await listOwnerDatasets("giswqs", { fetchImpl, token: "hf_secret" });
    assert.ok(!calls[0].url.includes("hf_secret"), calls[0].url);
  });

  it("surfaces the Hub's own error message rather than a bare status", async () => {
    const { fetchImpl } = stubFetch([
      {
        match: "/datasets",
        body: JSON.stringify({ error: "Repository not found" }),
        ok: false,
        status: 404,
      },
    ]);
    await assert.rejects(listOwnerDatasets("nobody", { fetchImpl }), /Repository not found/);
  });

  it("falls back to the status when the error body is not JSON", async () => {
    const { fetchImpl } = stubFetch([
      { match: "/datasets", body: "<html>oops</html>", ok: false, status: 503 },
    ]);
    await assert.rejects(listOwnerDatasets("nobody", { fetchImpl }), /503/);
  });

  it("rejects a 200 body that is not JSON at all", async () => {
    const { fetchImpl } = stubFetch([{ match: "/datasets", body: "<html>hi</html>" }]);
    await assert.rejects(listOwnerDatasets("giswqs", { fetchImpl }), /unexpected response/);
  });
});

describe("searchDatasets", () => {
  it("uses the Hub's real search endpoint", async () => {
    const { fetchImpl, calls } = stubFetch([{ match: "/datasets", body: "[]" }]);
    await searchDatasets("land cover", { fetchImpl });
    assert.equal(new URL(calls[0].url).searchParams.get("search"), "land cover");
  });
});

describe("fetchDataset", () => {
  it("returns the dataset when it exists", async () => {
    const { fetchImpl } = stubFetch([
      { match: "/datasets/giswqs/geospatial", body: JSON.stringify(rawDataset()) },
    ]);
    const dataset = await fetchDataset("giswqs/geospatial", { fetchImpl });
    assert.equal(dataset?.id, "giswqs/geospatial");
  });

  it("resolves to null rather than throwing when the repo is not visible", async () => {
    const { fetchImpl } = stubFetch([
      { match: "/datasets/", body: JSON.stringify({ error: "not found" }), ok: false, status: 404 },
    ]);
    assert.equal(await fetchDataset("nobody/nothing", { fetchImpl }), null);
  });
});

describe("listDatasetTree", () => {
  it("reads the repo root when no path is given", async () => {
    const { fetchImpl, calls } = stubFetch([{ match: "/tree/", body: "[]" }]);
    await listDatasetTree({ repoId: "giswqs/geospatial" }, { fetchImpl });
    assert.ok(
      calls[0].url.startsWith("https://huggingface.co/api/datasets/giswqs/geospatial/tree/main?"),
      calls[0].url,
    );
  });

  it("addresses a subfolder as a path segment, encoded per segment", async () => {
    const { fetchImpl, calls } = stubFetch([{ match: "/tree/", body: "[]" }]);
    await listDatasetTree({ repoId: "o/r", path: "country=AFG/tiles" }, { fetchImpl });
    assert.ok(calls[0].url.includes("/tree/main/country%3DAFG/tiles?"), calls[0].url);
  });

  it("tolerates a path with stray leading and trailing slashes", async () => {
    const { fetchImpl, calls } = stubFetch([{ match: "/tree/", body: "[]" }]);
    await listDatasetTree({ repoId: "o/r", path: "/landsat/" }, { fetchImpl });
    assert.ok(calls[0].url.includes("/tree/main/landsat?"), calls[0].url);
  });

  it("passes a continuation cursor through", async () => {
    const { fetchImpl, calls } = stubFetch([{ match: "/tree/", body: "[]" }]);
    await listDatasetTree({ repoId: "o/r", cursor: "ZXlK" }, { fetchImpl });
    assert.equal(new URL(calls[0].url).searchParams.get("cursor"), "ZXlK");
  });

  it("reports the next cursor from the Link header", async () => {
    const { fetchImpl } = stubFetch([
      {
        match: "/tree/",
        body: "[]",
        link: `<https://huggingface.co/api/datasets/o/r/tree/main?cursor=NEXT>; rel="next"`,
      },
    ]);
    const listing = await listDatasetTree({ repoId: "o/r" }, { fetchImpl });
    assert.equal(listing.nextCursor, "NEXT");
  });

  it("stops after one page when the response exposes no headers", async () => {
    const fetchImpl: HfFetch = async () => ({ ok: true, status: 200, text: async () => "[]" });
    const listing = await listDatasetTree({ repoId: "o/r" }, { fetchImpl });
    assert.equal(listing.nextCursor, null);
  });
});

describe("whoAmI", () => {
  it("reports the account name and its organizations", async () => {
    const { fetchImpl } = stubFetch([
      {
        match: "/whoami-v2",
        body: JSON.stringify({
          name: "giswqs",
          orgs: [{ name: "opengeos" }, { name: "gishub" }],
          auth: { accessToken: { role: "write" } },
        }),
      },
    ]);
    const identity = await whoAmI({ fetchImpl, token: "hf_x" });
    assert.equal(identity.name, "giswqs");
    assert.deepEqual(identity.orgs, ["opengeos", "gishub"]);
    assert.equal(identity.canWrite, true);
  });

  it("flags a read-only classic token before the user fills in a form", async () => {
    const { fetchImpl } = stubFetch([
      {
        match: "/whoami-v2",
        body: JSON.stringify({ name: "giswqs", auth: { accessToken: { role: "read" } } }),
      },
    ]);
    assert.equal((await whoAmI({ fetchImpl, token: "hf_x" })).canWrite, false);
  });

  it("treats a fine-grained token (no role) as possibly writable", async () => {
    // Its permissions are per-repo and not knowable here, so the create/commit
    // call is left as the authority rather than rejecting up front.
    const { fetchImpl } = stubFetch([
      { match: "/whoami-v2", body: JSON.stringify({ name: "giswqs" }) },
    ]);
    assert.equal((await whoAmI({ fetchImpl, token: "hf_x" })).canWrite, true);
  });

  it("refuses to call without a token", async () => {
    await assert.rejects(whoAmI({}), /access token is required/);
  });
});

describe("createDatasetRepo", () => {
  const created = JSON.stringify({
    url: `${HF_SITE}/datasets/giswqs/my-geodata`,
    name: "my-geodata",
  });

  it("posts a dataset repo and recovers the id from the returned URL", async () => {
    const { fetchImpl, calls } = stubFetch([{ match: "/repos/create", body: created }]);
    const result = await createDatasetRepo({ name: "my-geodata" }, { fetchImpl, token: "hf_x" });
    assert.equal(result.repoId, "giswqs/my-geodata");
    assert.equal(result.url, `${HF_SITE}/datasets/giswqs/my-geodata`);
    assert.deepEqual(JSON.parse(calls[0].body as string), {
      type: "dataset",
      name: "my-geodata",
      private: false,
    });
  });

  it("sends the namespace only when an organization was chosen", async () => {
    const { fetchImpl, calls } = stubFetch([{ match: "/repos/create", body: created }]);
    await createDatasetRepo(
      { name: "my-geodata", owner: "opengeos", private: true },
      { fetchImpl, token: "hf_x" },
    );
    assert.deepEqual(JSON.parse(calls[0].body as string), {
      type: "dataset",
      name: "my-geodata",
      organization: "opengeos",
      private: true,
    });
  });

  it("rejects an owner/name in the name field, which would create an unusable repo", async () => {
    const { fetchImpl } = stubFetch([{ match: "/repos/create", body: created }]);
    await assert.rejects(
      createDatasetRepo({ name: "giswqs/my-geodata" }, { fetchImpl, token: "hf_x" }),
      /name only/,
    );
  });

  it("rejects an empty name", async () => {
    const { fetchImpl } = stubFetch([{ match: "/repos/create", body: created }]);
    await assert.rejects(
      createDatasetRepo({ name: "  " }, { fetchImpl, token: "hf_x" }),
      /name is required/,
    );
  });

  it("refuses to call without a token", async () => {
    await assert.rejects(createDatasetRepo({ name: "x" }, {}), /access token is required/);
  });

  it("surfaces the Hub's permission error verbatim", async () => {
    const { fetchImpl } = stubFetch([
      {
        match: "/repos/create",
        body: JSON.stringify({
          error: "You don't have the rights to create a dataset under this namespace",
        }),
        ok: false,
        status: 403,
      },
    ]);
    await assert.rejects(
      createDatasetRepo({ name: "x", owner: "someoneelse" }, { fetchImpl, token: "hf_x" }),
      /don't have the rights/,
    );
  });
});

describe("upload size limits", () => {
  it("caps a whole selection well below what one file may be", () => {
    // The two bound different things: the per-file limit is what the storage
    // endpoint takes in one PUT, the total is what the tab can hold while every
    // file is materialized and the regular ones are base64-encoded on top. If
    // they ever converge the aggregate guard stops biting, which is exactly the
    // regression this locks out.
    assert.ok(
      HF_MAX_UPLOAD_TOTAL_BYTES < HF_MAX_UPLOAD_BYTES,
      `expected the total cap (${HF_MAX_UPLOAD_TOTAL_BYTES}) below the per-file cap (${HF_MAX_UPLOAD_BYTES})`,
    );
  });
});

describe("buildBlobViewUrl / buildTreeViewUrl", () => {
  it("points at a file's own page, not the repo root", () => {
    // The whole reason these exist: after an upload the panel should land on
    // what was just pushed, not the repo's front page.
    assert.equal(
      buildBlobViewUrl("giswqs/geospatial", "landsat/1984.tif"),
      `${HF_SITE}/datasets/giswqs/geospatial/blob/main/landsat/1984.tif`,
    );
  });

  it("points at a folder's listing", () => {
    assert.equal(
      buildTreeViewUrl("giswqs/geospatial", "landsat"),
      `${HF_SITE}/datasets/giswqs/geospatial/tree/main/landsat`,
    );
  });

  it("treats an empty folder as the repo root tree", () => {
    assert.equal(buildTreeViewUrl("o/r"), `${HF_SITE}/datasets/o/r/tree/main`);
    assert.equal(buildTreeViewUrl("o/r", "/"), `${HF_SITE}/datasets/o/r/tree/main`);
  });

  it("keeps the owner/name slash but encodes path segments", () => {
    assert.equal(
      buildTreeViewUrl("o/r", "country=AFG"),
      `${HF_SITE}/datasets/o/r/tree/main/country%3DAFG`,
    );
  });

  it("honours a non-default revision", () => {
    assert.equal(buildBlobViewUrl("o/r", "a.tif", "dev"), `${HF_SITE}/datasets/o/r/blob/dev/a.tif`);
  });
});

describe("synthesizeDataset", () => {
  it("builds a usable record from an id alone, for a pinned suggestion", () => {
    const dataset = synthesizeDataset("giswqs/s2-water-dataset");
    assert.equal(dataset?.id, "giswqs/s2-water-dataset");
    assert.equal(dataset?.owner, "giswqs");
    assert.equal(dataset?.name, "s2-water-dataset");
    assert.equal(dataset?.url, `${HF_SITE}/datasets/giswqs/s2-water-dataset`);
  });

  it("defaults to public and ungated, so a pinned entry stays browsable", () => {
    const dataset = synthesizeDataset("o/r");
    assert.equal(dataset?.private, false);
    assert.equal(dataset?.gated, false);
    assert.equal(canRenderFrom(dataset!), true);
  });

  it("rejects anything that is not owner/name", () => {
    assert.equal(synthesizeDataset("giswqs"), null);
    assert.equal(synthesizeDataset(""), null);
  });
});

describe("bytesToBase64", () => {
  it("encodes the three padding cases", () => {
    const encode = (text: string) => bytesToBase64(new TextEncoder().encode(text));
    assert.equal(encode("Man"), "TWFu");
    assert.equal(encode("Ma"), "TWE=");
    assert.equal(encode("M"), "TQ==");
  });

  it("encodes an empty input as an empty string", () => {
    assert.equal(bytesToBase64(new Uint8Array()), "");
  });

  it("round-trips arbitrary binary through the platform decoder", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255, 42]);
    assert.deepEqual(new Uint8Array(Buffer.from(bytesToBase64(bytes), "base64")), bytes);
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of 'abc'", async () => {
    assert.equal(
      await sha256Hex(new TextEncoder().encode("abc")),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes only the bytes a view covers, not its whole backing buffer", async () => {
    // Upload payloads are often views into a larger read buffer, so hashing the
    // backing store would produce an oid the Hub cannot match.
    const backing = new TextEncoder().encode("xxabcxx");
    const view = backing.subarray(2, 5);
    assert.equal(await sha256Hex(view), await sha256Hex(new TextEncoder().encode("abc")));
  });
});

describe("uploadDatasetFiles", () => {
  /** Routes for a repo where `a.geojson` goes into git and `b.tif` into LFS. */
  function uploadRoutes(options: { lfsHref?: string | null } = {}) {
    const upload =
      options.lfsHref === null
        ? {}
        : {
            actions: {
              upload: {
                href: options.lfsHref ?? "https://s3.example/put",
                header: { "x-amz": "1" },
              },
            },
          };
    return [
      {
        match: "/preupload/",
        body: JSON.stringify({
          files: [
            { path: "a.geojson", uploadMode: "regular", shouldIgnore: false },
            { path: "b.tif", uploadMode: "lfs", shouldIgnore: false },
          ],
        }),
      },
      {
        match: "/info/lfs/objects/batch",
        body: JSON.stringify({ objects: [{ oid: "IGNORED", size: 3, ...upload }] }),
      },
      { match: "s3.example", body: "" },
      {
        match: "/commit/",
        body: JSON.stringify({ commitUrl: `${HF_SITE}/datasets/o/r/commit/abc` }),
      },
    ];
  }

  const files = [
    { path: "a.geojson", content: new TextEncoder().encode("{}") },
    { path: "b.tif", content: new TextEncoder().encode("abc") },
  ];

  it("runs preupload, LFS staging, and commit in order", async () => {
    // The batch response is keyed by oid, so it has to carry the real digest.
    const oid = await sha256Hex(files[1].content);
    const routes = uploadRoutes();
    routes[1].body = JSON.stringify({
      objects: [
        { oid, size: 3, actions: { upload: { href: "https://s3.example/put", header: {} } } },
      ],
    });
    const { fetchImpl, calls } = stubFetch(routes);

    const result = await uploadDatasetFiles({ repoId: "o/r", files }, { fetchImpl, token: "hf_x" });

    assert.deepEqual(
      calls.map((call) => call.url.replace(/^https:\/\/huggingface\.co/, "")),
      [
        "/api/datasets/o/r/preupload/main",
        "/datasets/o/r.git/info/lfs/objects/batch",
        "https://s3.example/put",
        "/api/datasets/o/r/commit/main",
      ],
    );
    assert.equal(result.commitUrl, `${HF_SITE}/datasets/o/r/commit/abc`);
  });

  it("never sends the Hub token to the pre-signed storage URL", async () => {
    const oid = await sha256Hex(files[1].content);
    const routes = uploadRoutes();
    routes[1].body = JSON.stringify({
      objects: [
        {
          oid,
          size: 3,
          actions: { upload: { href: "https://s3.example/put", header: { "x-amz": "1" } } },
        },
      ],
    });
    const { fetchImpl, calls } = stubFetch(routes);
    await uploadDatasetFiles({ repoId: "o/r", files }, { fetchImpl, token: "hf_secret" });

    const put = calls.find((call) => call.url.includes("s3.example"));
    assert.equal(put?.method, "PUT");
    assert.equal(put?.headers.Authorization, undefined);
    assert.equal(put?.headers["x-amz"], "1");
  });

  it("inlines a regular file as base64 and references an LFS file by hash", async () => {
    const oid = await sha256Hex(files[1].content);
    const routes = uploadRoutes();
    routes[1].body = JSON.stringify({
      objects: [{ oid, size: 3, actions: { upload: { href: "https://s3.example/put" } } }],
    });
    const { fetchImpl, calls } = stubFetch(routes);
    await uploadDatasetFiles({ repoId: "o/r", files }, { fetchImpl, token: "hf_x" });

    const commit = calls.find((call) => call.url.includes("/commit/"));
    assert.equal(commit?.headers["Content-Type"], "application/x-ndjson");
    const lines = (commit?.body as string)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(lines[0].key, "header");
    assert.deepEqual(lines[1], {
      key: "file",
      value: { path: "a.geojson", encoding: "base64", content: "e30=" },
    });
    assert.deepEqual(lines[2], {
      key: "lfsFile",
      value: { path: "b.tif", algo: "sha256", oid, size: 3 },
    });
  });

  it("skips the PUT when the Hub already stores the blob", async () => {
    const oid = await sha256Hex(files[1].content);
    const routes = uploadRoutes();
    // No `actions` — the dedup path.
    routes[1].body = JSON.stringify({ objects: [{ oid, size: 3 }] });
    const { fetchImpl, calls } = stubFetch(routes);
    await uploadDatasetFiles({ repoId: "o/r", files }, { fetchImpl, token: "hf_x" });

    assert.ok(!calls.some((call) => call.url.includes("s3.example")));
    // The commit still references it by hash.
    const commit = calls.find((call) => call.url.includes("/commit/"));
    assert.ok((commit?.body as string).includes(oid));
  });

  it("drops a file the repo's .gitignore excludes and commits the rest", async () => {
    const routes = uploadRoutes();
    routes[0].body = JSON.stringify({
      files: [
        { path: "a.geojson", uploadMode: "regular", shouldIgnore: false },
        { path: "b.tif", uploadMode: "lfs", shouldIgnore: true },
      ],
    });
    const { fetchImpl, calls } = stubFetch(routes);
    await uploadDatasetFiles({ repoId: "o/r", files }, { fetchImpl, token: "hf_x" });

    // Nothing to stage, so no LFS round trip at all.
    assert.ok(!calls.some((call) => call.url.includes("lfs")));
    const commit = calls.find((call) => call.url.includes("/commit/"));
    assert.ok(!(commit?.body as string).includes("b.tif"));
  });

  it("fails when every selected file is ignored", async () => {
    const routes = uploadRoutes();
    routes[0].body = JSON.stringify({
      files: files.map((file) => ({ path: file.path, uploadMode: "regular", shouldIgnore: true })),
    });
    const { fetchImpl } = stubFetch(routes);
    await assert.rejects(
      uploadDatasetFiles({ repoId: "o/r", files }, { fetchImpl, token: "hf_x" }),
      /ignored by this dataset repo/,
    );
  });

  it("reports each phase as it advances", async () => {
    const oid = await sha256Hex(files[1].content);
    const routes = uploadRoutes();
    routes[1].body = JSON.stringify({
      objects: [{ oid, size: 3, actions: { upload: { href: "https://s3.example/put" } } }],
    });
    const { fetchImpl } = stubFetch(routes);
    const phases: string[] = [];
    await uploadDatasetFiles(
      { repoId: "o/r", files, onProgress: (progress) => phases.push(progress.phase) },
      { fetchImpl, token: "hf_x" },
    );
    assert.deepEqual(phases, ["preparing", "hashing", "uploading", "committing"]);
  });

  it("surfaces an LFS object error rather than committing a missing blob", async () => {
    const oid = await sha256Hex(files[1].content);
    const routes = uploadRoutes();
    routes[1].body = JSON.stringify({
      objects: [{ oid, size: 3, error: { code: 422, message: "Object too large" } }],
    });
    const { fetchImpl, calls } = stubFetch(routes);
    await assert.rejects(
      uploadDatasetFiles({ repoId: "o/r", files }, { fetchImpl, token: "hf_x" }),
      /Object too large/,
    );
    assert.ok(!calls.some((call) => call.url.includes("/commit/")));
  });

  it("surfaces a failed storage PUT rather than committing a missing blob", async () => {
    const oid = await sha256Hex(files[1].content);
    const routes = uploadRoutes();
    routes[1].body = JSON.stringify({
      objects: [{ oid, size: 3, actions: { upload: { href: "https://s3.example/put" } } }],
    });
    routes[2] = { match: "s3.example", body: "AccessDenied", ok: false, status: 403 };
    const { fetchImpl, calls } = stubFetch(routes);
    await assert.rejects(
      uploadDatasetFiles({ repoId: "o/r", files }, { fetchImpl, token: "hf_x" }),
      /403/,
    );
    assert.ok(!calls.some((call) => call.url.includes("/commit/")));
  });

  it("uses the caller's commit message when given one", async () => {
    const routes = uploadRoutes();
    routes[0].body = JSON.stringify({
      files: [{ path: "a.geojson", uploadMode: "regular", shouldIgnore: false }],
    });
    const { fetchImpl, calls } = stubFetch(routes);
    await uploadDatasetFiles(
      { repoId: "o/r", files: [files[0]], commitMessage: "Add boundaries" },
      { fetchImpl, token: "hf_x" },
    );
    const commit = calls.find((call) => call.url.includes("/commit/"));
    const header = JSON.parse((commit?.body as string).split("\n")[0]);
    assert.equal(header.value.summary, "Add boundaries");
  });

  it("refuses an empty selection and a missing token", async () => {
    await assert.rejects(
      uploadDatasetFiles({ repoId: "o/r", files: [] }, { token: "hf_x" }),
      /at least one file/,
    );
    await assert.rejects(
      uploadDatasetFiles({ repoId: "o/r", files }, {}),
      /access token is required/,
    );
  });
});
