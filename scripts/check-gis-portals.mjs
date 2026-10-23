#!/usr/bin/env node
// Check that every portal listed by the US State GIS, US Local GIS, and US
// Federal GIS panels still answers with datasets. City and county portals move
// and get renamed more often than anything else the app links to, and a dead
// entry fails quietly (an empty list or "Could not search"), so run this before
// a release or when a user reports a portal as broken.
//
//   npm run check:gis-portals            # every portal
//   npm run check:gis-portals -- local   # only US Local GIS
//   npm run check:gis-portals -- state   # only US State GIS
//   npm run check:gis-portals -- federal # only US Federal GIS
//
// Needs network access; it is not part of CI. Exits 1 if any portal fails.

import {
  ARCGIS_HUB_SEARCH_TYPES,
  fetchArcGisHubSiteGroups,
  searchArcGisHub,
} from "../packages/plugins/src/plugins/arcgis-hub-api.ts";
import { searchSocrataCatalog } from "../packages/plugins/src/plugins/socrata-api.ts";
import { US_FEDERAL_GIS_CATALOGS } from "../packages/plugins/src/plugins/us-federal-gis-catalogs.ts";
import { US_LOCAL_GIS_CATALOGS } from "../packages/plugins/src/plugins/us-local-gis-catalogs.ts";
import { US_STATE_GIS_CATALOGS } from "../packages/plugins/src/plugins/us-state-gis-catalogs.ts";

const CONCURRENCY = 8;
const TYPES = [...ARCGIS_HUB_SEARCH_TYPES, "Map Service", "Image Service"];

/**
 * Count one portal's datasets the way the panel searches them.
 *
 * @param {import("../packages/plugins/src/plugins/maplibre-arcgis-hub.ts").ArcGisHubCatalog} catalog
 * @returns {Promise<string>} How the portal was searched and what it held.
 */
async function checkPortal(catalog) {
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
];
if (which && !panels.some(([panel]) => panel === which)) {
  console.error(`Unknown panel "${which}"; expected state, local, or federal.`);
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
