#!/usr/bin/env node
// Regenerate packages/plugins/src/plugins/planetary-computer-collections.json,
// the bundled Planetary Computer collection list.
//
// Usage: npm run gen:planetary-computer-collections
//
// The Planetary Computer STAC API has at times sent its `/collections` listing
// without CORS headers, so a browser (or the Tauri webview) could not load the
// list the Planetary Computer panel opens with. The panel tries the live list
// first and falls back to this snapshot.
// .github/workflows/refresh-planetary-computer-collections.yml reruns this
// monthly and opens a pull request when the list changed.
//
// The file is written minified and the committed copy is that output run
// through the repo formatter (oxfmt, which the pre-commit hook applies). Format
// it before comparing or committing, or every line reads as changed:
//   npx oxfmt --write packages/plugins/src/plugins/planetary-computer-collections.json Only the fields the panel reads are
// kept (list/search text, extent, cloud-cover flag, item asset types), which
// keeps the lazily loaded chunk small. Selecting a collection still reads its
// items live, so a stale snapshot only hides collections added since.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COLLECTIONS_URL = "https://planetarycomputer.microsoft.com/api/stac/v1/collections";
const DESCRIPTION_MAX_CHARS = 300;
const KEYWORDS_MAX = 8;

const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/plugins/src/plugins/planetary-computer-collections.json",
);

function round(value) {
  return typeof value === "number" ? Math.round(value * 1e4) / 1e4 : value;
}

function slimCollection(collection) {
  const slim = { id: collection.id, type: "Collection" };
  if (collection.title) slim.title = collection.title;
  const description = (collection.description ?? "").replace(/\s+/g, " ").trim();
  slim.description =
    description.length > DESCRIPTION_MAX_CHARS
      ? `${description.slice(0, DESCRIPTION_MAX_CHARS).trimEnd()}…`
      : description;
  if (collection.keywords?.length) slim.keywords = collection.keywords.slice(0, KEYWORDS_MAX);
  if (collection.license) slim.license = collection.license;

  const bbox = collection.extent?.spatial?.bbox?.[0];
  const interval = collection.extent?.temporal?.interval?.[0];
  slim.extent = {
    spatial: { bbox: bbox ? [bbox.map(round)] : [[-180, -90, 180, 90]] },
    temporal: { interval: [interval ?? [null, null]] },
  };

  // The panel only checks whether the summary exists, to decide whether to
  // show the cloud-cover slider.
  const cloudCover = collection.summaries?.["eo:cloud_cover"];
  if (cloudCover) slim.summaries = { "eo:cloud_cover": cloudCover };

  // Asset keys and media types pick the default asset for a collection mosaic.
  const itemAssets = Object.entries(collection.item_assets ?? {});
  if (itemAssets.length) {
    slim.item_assets = Object.fromEntries(
      itemAssets.map(([key, asset]) => [key, asset.type ? { type: asset.type } : {}]),
    );
  }
  slim.links = [];
  return slim;
}

const response = await fetch(COLLECTIONS_URL);
if (!response.ok) {
  throw new Error(`GET ${COLLECTIONS_URL} failed: ${response.status} ${response.statusText}`);
}
const { collections } = await response.json();
if (!Array.isArray(collections) || collections.length === 0) {
  throw new Error(`GET ${COLLECTIONS_URL} returned no collections`);
}

const slim = collections.map(slimCollection).sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(OUT, `${JSON.stringify(slim, null, 0)}\n`);
console.log(`Wrote ${slim.length} collections to ${OUT}`);
