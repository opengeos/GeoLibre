import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assetFormat,
  assetTargets,
  canAddAsset,
  icechunkBranch,
  isIcechunkAsset,
  searchStacApi,
  type StacItem,
  zarrLayerRequest,
  zarrReaderTargetCheck,
  zarrStorePath,
  zarrTargetCheck,
} from "../packages/plugins/src/plugins/stac-api";

// Responses captured from the live catalogs. Zarr is published in shapes no single catalog shows,
// so the rules that read them are checked against what real services actually return.
function captured(name: string): unknown {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`./fixtures/stac-items/${name}.json`, import.meta.url)),
      "utf8",
    ),
  );
}

/** Runs a captured page through the panel's own parsing, as a search would. */
async function itemFrom(name: string, base: string): Promise<StacItem> {
  const fetcher = (async () =>
    new Response(JSON.stringify(captured(name)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  const result = await searchStacApi(
    {
      url: base,
      title: "captured",
      isApi: true,
      searchUrl: `${base}search`,
      collections: [],
      root: {},
    },
    { limit: 1 },
    fetcher,
  );
  return result.items[0];
}

test("Planetary Computer's era5 Zarr resolves its account, and offers only spatial variables", async () => {
  const item = await itemFrom("pc-era5", "https://planetarycomputer.microsoft.com/api/stac/v1/");
  const key = "precipitation_amount_1hour_Accumulation";
  const asset = item.assets[key];

  // The account lives in xarray:open_kwargs here, not table:storage_options.
  assert.equal(
    asset.href,
    "https://cpdataeuwest.blob.core.windows.net/era5/ERA5/2020/12/precipitation_amount_1hour_Accumulation.zarr",
  );
  assert.equal(assetFormat(asset), "zarr");
  assert.equal(canAddAsset(item, key, asset), true);

  // Each asset is keyed by the variable it holds, so that one is the only target.
  assert.deepEqual(assetTargets(item, key, asset), [{ id: key, label: `${key} (m)` }]);
  // `time1_bounds` spans time and nv, so it is never offered.
  const everyTarget = Object.keys(item.assets).flatMap((name) =>
    assetTargets(item, name, item.assets[name]).map((target) => target.id),
  );
  assert.equal(everyTarget.includes("time1_bounds"), false);
});

test("EOPF's Sentinel-2 assets address an array inside the store", async () => {
  const item = await itemFrom("eopf-sentinel2", "https://stac.core.eopf.eodc.eu/");
  const asset = item.assets.B02_10m;

  assert.equal(assetFormat(asset), "zarr");
  assert.equal(canAddAsset(item, "B02_10m", asset), true);

  // No datacube extension on these items: the href itself names the array.
  assert.deepEqual(item.properties["cube:variables"], undefined);
  const [target] = assetTargets(item, "B02_10m", asset);
  assert.ok(target, "the asset names the array it holds");
  assert.equal(target.id, "measurements/reflectance/r10m/b02");

  // The reader is handed the store, with that path as the variable.
  const request = zarrLayerRequest(asset.href, target.id);
  assert.match(request.url, /\.zarr$/);
  assert.equal(request.variable, "measurements/reflectance/r10m/b02");

  // The variable *is* the embedded path, so the preflight asks about the array the href names
  // rather than a sibling of the store root.
  const { url, path } = zarrStorePath(asset.href);
  assert.equal(path, target.id);
  const probed: string[] = [];
  const verdict = await zarrTargetCheck(url, target.id, (async (probe: string) => {
    probed.push(String(probe));
    return new Response(JSON.stringify({ node_type: "array" }), { status: 200 });
  }) as unknown as typeof fetch);
  assert.equal(verdict, "array");
  assert.deepEqual(probed, [`${url}/measurements/reflectance/r10m/b02/zarr.json`]);
});

test("UGS's Icechunk asset names a repository, and takes its variables from the item", async () => {
  const item = await itemFrom("ubm-icechunk", "https://ubm-assets.geology.utah.gov/stac/");
  const asset = item.assets.data;

  // The media type is the plain Zarr one: only `icechunk:branch` says how the store is read.
  assert.equal(asset.type, "application/vnd.zarr");
  assert.equal(assetFormat(asset), "zarr");
  assert.equal(isIcechunkAsset(asset, item), true);
  assert.equal(icechunkBranch(asset, item), "main");

  // The href names the repository, not a `.zarr` directory, so nothing is embedded to split off
  // and every variable the item declares is on offer.
  assert.equal(zarrStorePath(asset.href).path, undefined);
  assert.equal(canAddAsset(item, "data", asset), true);
  const targets = assetTargets(item, "data", asset).map((target) => target.id);
  assert.equal(targets.length, 12);
  assert.ok(targets.includes("AET"), "the item's own variables are what the picker offers");

  // A repository is read through its manifest, so the preflight asks it rather than the URL.
  const asked: string[] = [];
  const verdict = await zarrReaderTargetCheck(async (key) => {
    asked.push(key);
    return key === "/AET/zarr.json"
      ? new TextEncoder().encode(JSON.stringify({ node_type: "array" }))
      : undefined;
  }, "AET");
  assert.equal(verdict, "array");
  assert.deepEqual(asked, ["/AET/zarr.json"]);
});
