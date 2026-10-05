/** Structured renderer failure forwarded to the application's Diagnostics panel. */
export interface MapDiagnosticEvent {
  message: string;
  detail?: string;
  source?: string;
  status?: number;
  url?: string;
  /**
   * The store layer the failure belongs to, when the engine knows it directly
   * (Cesium, ArcGIS). The 2D engines leave it out; their `source` id names the
   * layer instead.
   */
  layerId?: string;
  /**
   * Set when the event is one failed tile of a layer and the engine counts its
   * tiles: how many loaded and failed so far, this one included. Lets the app
   * tell "every tile fails" (a broken URL or key) from a sparse tile set.
   */
  tiles?: { loaded: number; failed: number };
}

/** A MapLibre tile reduced to the fields that identify it in a diagnostic. */
export interface TileDiagnosticSummary {
  z?: number;
  x?: number;
  y?: number;
  overscaledZ?: number;
  wrap?: number;
  state?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function finiteNumber(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Reduces the `tile` of a MapLibre error event to its coordinates and load
 * state. The tile object holds its worker actor, whose `globalScope` is the
 * whole `window`, so serializing it as-is dumped kilobytes of unrelated browser
 * state into every failed tile's Diagnostics entry.
 *
 * @param tile - The `tile` property of a MapLibre error event, if any.
 * @returns The tile summary, or undefined when the event carries no tile.
 */
export function summarizeDiagnosticTile(tile: unknown): TileDiagnosticSummary | undefined {
  const record = asRecord(tile);
  if (!record) return undefined;
  const tileId = asRecord(record.tileID);
  const canonical = asRecord(tileId?.canonical);
  return {
    z: finiteNumber(canonical, "z"),
    x: finiteNumber(canonical, "x"),
    y: finiteNumber(canonical, "y"),
    overscaledZ: finiteNumber(tileId, "overscaledZ"),
    wrap: finiteNumber(tileId, "wrap"),
    state: typeof record.state === "string" ? record.state : undefined,
  };
}
