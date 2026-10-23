/** The layer records a vector-file load produces, and their type guards. */

import type { FeatureCollection } from "geojson";
import { unregisterKmlSuperOverlay } from "../kml-super-overlay";

export interface LoadedVectorLayer {
  data: FeatureCollection;
  name?: string;
  path: string;
  /** Enclosing KML Folder names, reconstructed as nested layer groups. */
  groupPath?: string[];
  /**
   * Epoch-ms time bounds when the layer is a frame of time-tagged KML
   * placemarks. Set (with `groupId`/`visible`) by {@link sequenceTimeFrames};
   * the Time Slider animates these frames.
   */
  timeSpan?: { begin: number | null; end: number | null };
  /** Shared group id linking the frames of one animation. */
  groupId?: string;
  /** Initial visibility: only the first time step of a sequence starts visible. */
  visible?: boolean;
}

/**
 * A georeferenced image overlay produced by a KML/KMZ `<GroundOverlay>`. Unlike
 * {@link LoadedVectorLayer} it carries no `FeatureCollection`; the caller turns
 * it into an `image`-type store layer via `addImageOverlayLayer`. The `kind`
 * tag distinguishes it from a vector layer in a mixed load result.
 */
export interface LoadedImageOverlay {
  kind: "image-overlay";
  name: string;
  path: string;
  /** Image data URL (from a KMZ archive) or an absolute URL (from a KML). */
  url: string;
  /** Four `[lng, lat]` corners: top-left, top-right, bottom-right, bottom-left. */
  coordinates: [number, number][];
  /** Overlay extent as `[west, south, east, north]` in WGS84 degrees. */
  bounds: [number, number, number, number];
  /** Overlay opacity in [0, 1]. */
  opacity: number;
  /**
   * Epoch-ms time bounds when the overlay is a `<TimeSpan>`/`<TimeStamp>` frame
   * in a time-animated sequence. Set (with `groupId`/`visible`) by
   * {@link sequenceTimeFrames}; the Time Slider animates these frames.
   */
  timeSpan?: { begin: number | null; end: number | null };
  /** Shared group id linking the frames of one animation. */
  groupId?: string;
  /** Initial visibility: only the first frame of a sequence starts visible. */
  visible?: boolean;
}

/** A tiled KML Super-Overlay registered with GeoLibre's in-memory tile protocol. */
export interface LoadedKmlSuperOverlay {
  kind: "kml-super-overlay";
  name: string;
  path: string;
  url: string;
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
  tileSize: number;
}

/**
 * A 3D model produced by a KML/KMZ `<Model>` (a COLLADA `.dae` converted to a
 * self-contained GLB). The caller turns it into a deck.gl scenegraph layer. The
 * `kind` tag distinguishes it from a vector layer in a mixed load result.
 */
export interface LoadedModel {
  kind: "model";
  name: string;
  path: string;
  /** GLB model as a `data:` URL (textures embedded), renderable as glTF. */
  url: string;
  /** Model location in WGS84 degrees and meters. */
  longitude: number;
  latitude: number;
  altitude: number;
  /** `<Orientation>` heading/tilt/roll in degrees. */
  heading: number;
  tilt: number;
  roll: number;
  /** `<Scale>` factors along the model's x/y/z axes. */
  scale: { x: number; y: number; z: number };
  /**
   * The model's extent in meters (max distance from its anchored origin to any
   * bounding-box corner), used to frame it on load. `0` when unknown.
   */
  radiusMeters: number;
  /** Model-space vertical bounds after COLLADA unit/up-axis handling. */
  verticalMinMeters: number;
  verticalMaxMeters: number;
}

/**
 * A single result from a vector-file load: a vector layer, an image overlay, or
 * a 3D model. A KMZ/KML file can yield a mix (placemarks plus ground overlays
 * plus models), mirroring how a GPX file yields several vector layers.
 */
export type LoadedLayer =
  | LoadedVectorLayer
  | LoadedImageOverlay
  | LoadedKmlSuperOverlay
  | LoadedModel;

/** Narrow a {@link LoadedLayer} to its image-overlay variant. */
export function isLoadedImageOverlay(layer: LoadedLayer): layer is LoadedImageOverlay {
  return "kind" in layer && layer.kind === "image-overlay";
}

export function isLoadedKmlSuperOverlay(layer: LoadedLayer): layer is LoadedKmlSuperOverlay {
  return "kind" in layer && layer.kind === "kml-super-overlay";
}

/** Free protocol archives accumulated by a batch that ultimately rejects. */
export function unregisterLoadedKmlSuperOverlays(layers: readonly LoadedLayer[]): void {
  for (const layer of layers) {
    if (isLoadedKmlSuperOverlay(layer)) unregisterKmlSuperOverlay(layer.url);
  }
}

/** Narrow a {@link LoadedLayer} to its 3D-model variant. */
export function isLoadedModel(layer: LoadedLayer): layer is LoadedModel {
  return "kind" in layer && layer.kind === "model";
}

/** Narrow a {@link LoadedLayer} to its vector variant. */
export function isLoadedVectorLayer(layer: LoadedLayer): layer is LoadedVectorLayer {
  return !("kind" in layer);
}
