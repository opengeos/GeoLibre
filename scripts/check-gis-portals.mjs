#!/usr/bin/env node
// Check that every portal listed by the US State GIS, US Local GIS, US Federal
// GIS, and India GIS panels still answers with datasets. City and county portals move
// and get renamed more often than anything else the app links to, and a dead
// entry fails quietly (an empty list or "Could not search"), so run this before
// a release or when a user reports a portal as broken.
//
//   npm run check:gis-portals            # every portal
//   npm run check:gis-portals -- local   # only US Local GIS
//   npm run check:gis-portals -- state   # only US State GIS
//   npm run check:gis-portals -- federal # only US Federal GIS
//   npm run check:gis-portals -- india   # only India GIS (downloads every file)
//
// Needs network access; it is not part of CI. Exits 1 if any portal fails.

import {
  ARCGIS_HUB_SEARCH_TYPES,
  fetchArcGisHubSiteGroups,
  searchArcGisHub,
} from "../packages/plugins/src/plugins/arcgis-hub-api.ts";
import { INDIA_GIS_CATALOGS } from "../packages/plugins/src/plugins/india-gis-catalogs.ts";
import { searchSocrataCatalog } from "../packages/plugins/src/plugins/socrata-api.ts";
import { US_FEDERAL_GIS_CATALOGS } from "../packages/plugins/src/plugins/us-federal-gis-catalogs.ts";
import { US_LOCAL_GIS_CATALOGS } from "../packages/plugins/src/plugins/us-local-gis-catalogs.ts";
import { US_STATE_GIS_CATALOGS } from "../packages/plugins/src/plugins/us-state-gis-catalogs.ts";

const CONCURRENCY = 8;
const TYPES = [...ARCGIS_HUB_SEARCH_TYPES, "Map Service", "Image Service"];

/** One download per GeoJSON URL, shared by the cards that reuse a file. */
const geoJsonDownloads = new Map();

/**
 * Download a GeoJSON file the way the panel's "Add to map" reads it.
 *
 * @param {string} url
 * @returns {Promise<import("geojson").FeatureCollection>}
 */
function fetchGeoJson(url) {
  if (!geoJsonDownloads.has(url)) {
    geoJsonDownloads.set(
      url,
      fetch(url).then(async (response) => {
        if (!response.ok) throw new Error(`${url} answered ${response.status}`);
        const data = JSON.parse(await response.text());
        if (data?.type !== "FeatureCollection" || !Array.isArray(data.features)) {
          throw new Error(`${url} is not a GeoJSON FeatureCollection`);
        }
        return data;
      }),
    );
  }
  return geoJsonDownloads.get(url);
}

/**
 * Check that a fixed-list card loads features in longitude/latitude.
 *
 * @param {import("../packages/plugins/src/plugins/arcgis-hub-api.ts").ArcGisHubItem} item
 * @returns {Promise<void>}
 */
async function checkItem(item) {
  const data = await fetchGeoJson(item.dataUrl);
  const filter = item.featureFilter;
  const features = filter
    ? data.features.filter((feature) =>
        filter.values.includes(String(feature.properties?.[filter.property])),
      )
    : data.features;
  if (features.length === 0) throw new Error(`${item.id} has no features`);
  // A projected file (Web Mercator metres) parses fine but renders nowhere.
  if (!features.every((feature) => isLonLat(feature.geometry?.coordinates))) {
    throw new Error(`${item.id} is not in longitude/latitude`);
  }
}

/**
 * Whether every position in a GeoJSON coordinate array is longitude/latitude.
 *
 * @param {unknown} coordinates A geometry's `coordinates`, at any nesting depth.
 * @returns {boolean}
 */
function isLonLat(coordinates) {
  if (!Array.isArray(coordinates)) return true;
  if (typeof coordinates[0] === "number") {
    return Math.abs(coordinates[0]) <= 180 && Math.abs(coordinates[1]) <= 90;
  }
  return coordinates.every(isLonLat);
}

/**
 * Count one portal's datasets the way the panel searches them.
 *
 * @param {import("../packages/plugins/src/plugins/maplibre-arcgis-hub.ts").ArcGisHubCatalog} catalog
 * @returns {Promise<string>} How the portal was searched and what it held.
 */
async function checkPortal(catalog) {
  if (catalog.items?.length) {
    await Promise.all(catalog.items.map(checkItem));
    return `${catalog.items.length} GeoJSON files`;
  }
  if (catalog.socrataDomain) {
    const page = await searchSocrataCatalog(catalog.socrataDomain, "", { num: 1 });
    if (page.results.length === 0) throw new Error("no spatial datasets");
    return `socrata, ${page.total} datasets`;
  }
  let groups;
  if (catalog.siteId) {
    groups = await fetchArcGisHubSiteGroups(catalog.siteId).catch(() => undefined);
  }
  const scope = groups?.length ? { groups } : { orgId: catalog.orgId };
  if (!scope.groups && !scope.orgId) throw new Error("no catalog groups and no organization");
  const page = await searchArcGisHub("", { ...scope, num: 1, types: TYPES });
  if (page.total === 0) throw new Error("no datasets");
  return `${scope.groups ? "site" : "org"}, ${page.total} items`;
}

const which = process.argv[2];
const panels = [
  ["state", US_STATE_GIS_CATALOGS],
  ["local", US_LOCAL_GIS_CATALOGS],
  ["federal", US_FEDERAL_GIS_CATALOGS],
  ["india", INDIA_GIS_CATALOGS],
];
if (which && !panels.some(([panel]) => panel === which)) {
  console.error(`Unknown panel "${which}"; expected state, local, federal, or india.`);
  process.exit(2);
}
const sets = panels
  .filter(([panel]) => !which || panel === which)
  .flatMap(([panel, catalogs]) => catalogs.map((set) => [panel, set]));
const jobs = sets.flatMap(([panel, set]) =>
  set.catalogs.map((catalog) => ({ label: `${panel}/${set.name}/${catalog.name}`, catalog })),
);

const failures = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const { label, catalog } = jobs[next++];
    try {
      console.log(`ok    ${label} (${await checkPortal(catalog)})`);
    } catch (error) {
      failures.push(label);
      console.log(`FAIL  ${label} <${catalog.url}>: ${error.message}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`\n${jobs.length - failures.length}/${jobs.length} portals answered.`);
if (failures.length) {
  console.log(`Failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
