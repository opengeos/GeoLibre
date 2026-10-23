/**
 * Tile URLs for the in-process PostGIS tile renderer (`postgis-tiles.ts`).
 *
 * Pure and dependency-free so it unit-tests without MapLibre or Tauri.
 *
 * The URL is persisted in `.geolibre.json` projects, so it must never carry
 * credentials: it names the connection by its password-masked label (the same
 * label editable PostGIS layers persist as `postgisConnectionLabel`) and the
 * protocol handler resolves that back to a connection string at request time.
 */

export const POSTGIS_TILES_PROTOCOL = "geolibre-pgtiles";

/** `metadata.sourceKind` of a layer drawn by the in-process renderer. */
export const POSTGIS_TILES_SOURCE_KIND = "postgis-tiles";

/**
 * Tile requests sent to the backend at once per connection: its pool size
 * (`POOL_SIZE` in `postgis_tiles.rs`, kept equal by
 * `tests/postgis-tiles-url.test.ts`). The rest wait in the frontend, where a
 * tile MapLibre cancels can still be dropped; once sent, it cannot be.
 */
export const MAX_TILES_IN_FLIGHT = 4;

export interface PostgisTileSourceRef {
  /** Password-masked connection label (see `savedPostgresConnectionLabel`). */
  connectionLabel: string;
  schema: string;
  table: string;
  geometryColumn: string;
  /** SRID assumed for a geometry column registered with SRID 0. */
  defaultSrid?: string;
}

export interface PostgisTileRequest extends PostgisTileSourceRef {
  z: number;
  x: number;
  y: number;
}

/** The `{z}/{x}/{y}` tile template for one PostGIS source. */
export function postgisTilesUrl(source: PostgisTileSourceRef): string {
  const params = new URLSearchParams({
    conn: source.connectionLabel,
    schema: source.schema,
    table: source.table,
    geom: source.geometryColumn,
  });
  const srid = source.defaultSrid?.trim();
  if (srid) params.set("srid", srid);
  return `${POSTGIS_TILES_PROTOCOL}://tile/{z}/{x}/{y}?${params.toString()}`;
}

/** Parse an expanded tile URL back into its source and tile coordinates. */
export function parsePostgisTileUrl(url: string): PostgisTileRequest {
  // Split the URL by hand rather than read `URL.hostname`/`pathname`: this is
  // a non-special scheme, which Chromium (and Android WebView) before 130
  // parsed as an opaque path with an empty host.
  const prefix = `${POSTGIS_TILES_PROTOCOL}://tile/`;
  if (!url.startsWith(prefix)) {
    throw new Error("Invalid PostGIS tile URL.");
  }
  const rest = url.slice(prefix.length).split("#")[0];
  const queryStart = rest.indexOf("?");
  const path = queryStart === -1 ? rest : rest.slice(0, queryStart);
  const params = new URLSearchParams(queryStart === -1 ? "" : rest.slice(queryStart + 1));
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 3) {
    throw new Error("Invalid PostGIS tile URL.");
  }
  const [z, x, y] = parts.map(parseTileCoordinate);
  const connectionLabel = params.get("conn") ?? "";
  const schema = params.get("schema") ?? "";
  const table = params.get("table") ?? "";
  const geometryColumn = params.get("geom") ?? "";
  if (!connectionLabel || !schema || !table || !geometryColumn) {
    throw new Error("Invalid PostGIS tile URL.");
  }
  const defaultSrid = params.get("srid") ?? undefined;
  return {
    connectionLabel,
    schema,
    table,
    geometryColumn,
    defaultSrid,
    z,
    x,
    y,
  };
}

function parseTileCoordinate(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("Invalid PostGIS tile coordinate.");
  }
  return parsed;
}

/** The masked connection labels that the given layers' PostGIS tiles use. */
export function postgisTilesConnectionLabels(
  layers: ReadonlyArray<{ metadata?: Record<string, unknown> }>,
): Set<string> {
  const labels = new Set<string>();
  for (const { metadata } of layers) {
    const label = metadata?.postgisConnectionLabel;
    if (metadata?.sourceKind === POSTGIS_TILES_SOURCE_KIND && typeof label === "string" && label) {
      labels.add(label);
    }
  }
  return labels;
}
