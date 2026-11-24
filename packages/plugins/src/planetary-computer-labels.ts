/** Translatable strings for the panel's GeoLibre buttons. */
export interface PlanetaryComputerLabels {
  stacBrowser: string;
  stacBrowserTitle: string;
  timeSlider: string;
  timeSliderTitle: string;
  colorbar: string;
  colorbarTitle: string;
  clipToMap: string;
  clipToMapTitle: string;
  /** Name of a clip layer; `{{item}}` is replaced by the STAC item id. */
  clipLayerName: string;
  /** Error shown when the clip area does not overlap the item. */
  clipOutsideItem: string;
  /** Error shown when the scene or the active map cannot take a clip layer. */
  clipUnavailable: string;
  /** Name of the Time Slider layer; `{{collection}}` is replaced by the collection title. */
  timeSeriesLayerName: string;
  /** Error shown when fewer than two results carry a date. */
  timeSliderNeedsDates: string;
  /** Error shown when the Time Slider could not be opened. */
  timeSliderUnavailable: string;
}

// English fallbacks, shown until the host calls setPlanetaryComputerLabels (and
// wherever the plugin runs without one). The app's own copy is the
// `planetaryComputer.*` block of en.json, passed in by usePluginLabelSync, the
// same arrangement as the other built-in panels' label setters.
const DEFAULT_LABELS: PlanetaryComputerLabels = {
  stacBrowser: "Browse in STAC catalogs",
  stacBrowserTitle:
    "Open this collection in the STAC catalogs panel to add point clouds, GeoParquet, Zarr, and other assets the raster tiler cannot draw",
  timeSlider: "Animate in Time slider",
  timeSliderTitle:
    "Step through these results by date in the Time slider and chart a pixel through time",
  colorbar: "Show colorbar",
  colorbarTitle: "Add a colorbar for this layer's colormap and value range to the map",
  clipToMap: "Add clip to map",
  clipToMapTitle:
    "Clip this scene to the drawn box (or the map view) and add its raw band values as a raster layer for analysis",
  clipLayerName: "{{item}} clip",
  clipOutsideItem:
    "The clip area does not overlap this scene. Draw a box inside its footprint or move the map over it.",
  clipUnavailable: "This scene cannot be added as a clip on this map.",
  timeSeriesLayerName: "{{collection}} time series",
  timeSliderNeedsDates: "At least two results with different dates are needed for a time series.",
  timeSliderUnavailable: "The Time slider is not available on this map.",
};

export let planetaryComputerLabels: PlanetaryComputerLabels = DEFAULT_LABELS;

/**
 * Sets the translated strings for the panel's GeoLibre buttons.
 *
 * The buttons read these when they are drawn, so a language switch shows up the
 * next time the panel renders a view.
 *
 * @param next - The translated labels; missing keys keep their English default.
 */
export function setPlanetaryComputerLabels(next: Partial<PlanetaryComputerLabels>): void {
  planetaryComputerLabels = { ...DEFAULT_LABELS, ...next };
}
