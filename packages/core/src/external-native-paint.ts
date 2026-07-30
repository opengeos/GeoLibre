/**
 * Paint ownership for plugin-registered native layers.
 *
 * A plugin can register a MapLibre `CustomLayerInterface` (a WebGL layer that
 * draws itself, e.g. a Zarr renderer that reprojects chunks on the GPU) through
 * `registerExternalNativeLayer`. Such a layer has **no MapLibre paint
 * properties**, so GeoLibre's Style panel editors (raster opacity/brightness/
 * saturation/contrast/hue, or the vector paint editors) cannot reach it: every
 * `setPaintProperty` call is dropped and the control looks functional while
 * doing nothing (opengeos/GeoLibre#1445).
 *
 * The registration therefore declares `paintMode: "plugin"`, which lands in the
 * store layer as `metadata.paintMode` so the UI can hide the editors it cannot
 * apply, and may additionally supply a {@link ExternalNativePaintBridge} so the
 * generic controls GeoLibre keeps (opacity, visibility) are forwarded to the
 * custom layer's own API.
 *
 * The bridge holds live functions, so it cannot live in `metadata` (that is
 * serialized into `.geolibre.json`). It is kept in this module-level registry
 * instead, keyed by layer id, and the layer record only carries the
 * serializable `paintMode` flag.
 */
export interface ExternalNativePaintBridge {
  /**
   * Apply an opacity in [0, 1] to the plugin's layer (e.g.
   * `zarrLayer.setOpacity(value)`). When supplied, GeoLibre keeps its Opacity
   * sliders live for the layer and calls this whenever the value changes.
   */
  setOpacity?: (opacity: number) => void;
  /**
   * Apply the panel's show/hide state. MapLibre already honors `visibility` on
   * a custom layer, so this is only needed by layers that also want to release
   * resources or stop fetching while hidden.
   */
  setVisibility?: (visible: boolean) => void;
}

/** Serializable paint-ownership marker stored in `GeoLibreLayer.metadata`. */
export type ExternalNativePaintMode = "geolibre" | "plugin";

/**
 * True when the plugin that registered this layer paints it itself, so GeoLibre
 * must not offer (or apply) MapLibre paint properties for it.
 */
/**
 * Whether a layer is drawn by a **custom render layer** its control created — a
 * deck.gl overlay, 3D Tiles, or Add Vector Layer's own MapLibre layers — rather
 * than by GeoLibre's layer sync. `metadata.customLayerType` is what marks one,
 * and it is the flag `syncExternalNativeLayer` branches on: for these layers the
 * sync only *moves and filters* native layers that already exist, so nothing
 * appears on the map unless the owning control (re)creates them.
 *
 * Lives here, in core, so the map's dispatch and the consumers that need to
 * reason about it — the Layer Library's "can this be re-added and rendered?"
 * gate (issue #1520) — share one definition and cannot drift.
 *
 * @param layer - A store layer (metadata only).
 * @returns True when only the owning control can create the layer's map output.
 */
export function controlRendersLayer(layer: { metadata: Record<string, unknown> }): boolean {
  return typeof layer.metadata.customLayerType === "string";
}

export function pluginOwnsPaint(layer: { metadata: Record<string, unknown> }): boolean {
  return layer.metadata.paintMode === "plugin";
}

const paintBridges = new Map<string, ExternalNativePaintBridge>();

/** Register (or replace) the paint bridge a plugin supplied for a layer. */
export function setExternalNativePaintBridge(
  layerId: string,
  bridge: ExternalNativePaintBridge | undefined,
): void {
  if (bridge && (bridge.setOpacity || bridge.setVisibility)) {
    paintBridges.set(layerId, bridge);
  } else {
    paintBridges.delete(layerId);
  }
}

/** Drop a layer's paint bridge (on unregister, or when the layer is removed). */
export function clearExternalNativePaintBridge(layerId: string): void {
  paintBridges.delete(layerId);
}

/** The paint bridge for a layer, if its plugin supplied one. */
export function getExternalNativePaintBridge(
  layerId: string,
): ExternalNativePaintBridge | undefined {
  return paintBridges.get(layerId);
}

/**
 * True when a plugin-painted layer bridged `setOpacity`, so an Opacity slider
 * would actually reach the renderer. It says nothing about GeoLibre-painted
 * layers, which have no bridge: the Style and Layers panels combine it with
 * `!pluginOwnsPaint(layer)` to decide whether to show the slider at all.
 */
export function supportsBridgedOpacity(layerId: string): boolean {
  return typeof paintBridges.get(layerId)?.setOpacity === "function";
}
