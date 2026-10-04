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
