import { A5_PLUGIN_ID } from "./maplibre-a5";
import { DGGAL_PLUGIN_ID } from "./maplibre-dggal";
import { DGGRID_PLUGIN_ID } from "./maplibre-dggrid";
import { GEOHASH_PLUGIN_ID } from "./maplibre-geohash";
import { H3_PLUGIN_ID } from "./maplibre-h3";
import { OLC_PLUGIN_ID } from "./maplibre-olc";
import { S2_PLUGIN_ID } from "./maplibre-s2";
import { TILECODE_PLUGIN_ID } from "./maplibre-tilecode";

/**
 * Plugin ids grouped under the Plugins menu's "DGGS" submenu: the discrete
 * global grid systems (H3, S2, A5, DGGRID, DGGAL, OLC, Geohash, Tilecode)
 * users can toggle independently. Mirrors WEB_SERVICE_PLUGIN_IDS in
 * web-service-sync.ts.
 */
export const DGGS_PLUGIN_IDS = [
  H3_PLUGIN_ID,
  S2_PLUGIN_ID,
  A5_PLUGIN_ID,
  DGGRID_PLUGIN_ID,
  DGGAL_PLUGIN_ID,
  OLC_PLUGIN_ID,
  GEOHASH_PLUGIN_ID,
  TILECODE_PLUGIN_ID,
] as const;
