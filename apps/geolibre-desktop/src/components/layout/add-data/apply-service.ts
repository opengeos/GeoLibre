/**
 * Turns a saved {@link ServiceLibraryEntry} (kind + field bag) into a map layer,
 * without the Add Data dialog. This is the shared core the dialog's web-service
 * sources and the Browser panel both build on:
 *
 * - **Pure layer builders** (`buildXyzLayer` / `buildWmsLayer` / `buildWmtsLayer`
 *   / `buildWfsGeoJsonLayer`) construct a {@link GeoLibreLayer} from resolved
 *   parameters. They have no React, network, or MapLibre dependencies, so the
 *   dialog sources call them from their submit handlers and they unit-test in
 *   isolation.
 * - **Field mappers** (`*FieldsToParams` / `wfsFieldsToRequest` /
 *   `arcgisFieldsToOptions`) translate a stored `ServiceFields` bag into those
 *   parameters, mirroring how each source's `applyFields` reads the same fields.
 * - **`applyServiceEntry`** is the imperative dispatcher the Browser panel calls:
 *   it maps the entry's fields, does any async resolution (XYZ short-URL,
 *   WFS GetFeature), and adds the resulting layer to the store. The heavy,
 *   browser-only dependencies (the XYZ MapLibre protocol, the ArcGIS plugin, the
 *   WFS fetch) are imported dynamically so this module's pure exports stay
 *   importable under Node for tests.
 */

import type { GeoLibreLayer } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
// Type-only: erased at compile time, so importing it does not pull maplibre-gl
// (which `xyz-url` imports at runtime) into the pure builder surface.
import type { ArcGISLayerType, ArcGISSourceType } from "@geolibre/plugins";
import type { FeatureCollection } from "geojson";
import type { RefObject } from "react";
import type { ResolvedXyzTileUrl } from "../../../lib/xyz-url";
import {
  attributionForTileUrl,
  createBaseLayer,
  createWmsTileUrl,
  normalizeWmsVersion,
  stripOgcOperationParams,
  wmsVersionFromEndpoint,
} from "./helpers";
import {
  serviceFieldBoolean,
  serviceFieldString,
  type ServiceFields,
  type ServiceLibraryEntry,
} from "./service-library";

/**
 * Parses a tile-size field, falling back to the MapLibre default of 256 for a
 * non-numeric, zero, or negative value (a negative size would otherwise reach
 * the raster source unchecked, since `Number("-256")` is truthy).
 */
function toTileSize(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 256;
}

// --- XYZ -------------------------------------------------------------------

export interface XyzLayerParams {
  name: string;
  /** A tile URL already resolved by `xyz-url` (redirect-followed for shortUrl). */
  tileUrl: ResolvedXyzTileUrl;
  tileSize: string;
  shortUrl: boolean;
}

/**
 * Builds an XYZ raster tile layer from an already-resolved tile URL. The URL
 * resolution (and, for `shortUrl`, the MapLibre protocol registration) happens
 * in the caller so this stays pure; see {@link applyServiceEntry}'s xyz branch.
 *
 * @param params - The layer name, resolved tile URL, tile size, and shortUrl flag.
 * @returns The constructed XYZ layer.
 */
export function buildXyzLayer(params: XyzLayerParams): GeoLibreLayer {
  const { name, tileUrl, tileSize, shortUrl } = params;
  return createBaseLayer(
    name,
    "xyz",
    {
      type: "raster",
      tiles: [tileUrl.renderUrl],
      tileSize: toTileSize(tileSize),
      url: tileUrl.originalUrl,
    },
    {
      originalUrl: shortUrl ? tileUrl.originalUrl : undefined,
      resolvedUrl: tileUrl.redirected ? tileUrl.url : undefined,
      sourceKind: "xyz-url",
    },
  );
}

/** The XYZ fields needed to resolve a tile URL and build the layer. */
export interface XyzRequest {
  url: string;
  tileSize: string;
  shortUrl: boolean;
}

/** Reads the XYZ fields from a saved entry, mirroring `XyzSource.applyFields`. */
export function xyzFieldsToRequest(fields: ServiceFields): XyzRequest {
  return {
    url: serviceFieldString(fields, "url"),
    tileSize: serviceFieldString(fields, "tileSize", "256"),
    shortUrl: serviceFieldBoolean(fields, "shortUrl", false),
  };
}

// --- WMS -------------------------------------------------------------------

export interface WmsLayerParams {
  name: string;
  endpoint: string;
  layers: string;
  styles: string;
  format: string;
  transparent: boolean;
  tileSize: string;
  version: string;
}

/**
 * Builds a WMS raster layer whose tiles are a GetMap request template. Strips
 * any leftover OGC operation parameters from the endpoint and normalizes the
 * protocol version, matching `WmsSource`'s submit path exactly.
 *
 * @param params - The layer name and WMS request parameters.
 * @returns The constructed WMS layer.
 */
export function buildWmsLayer(params: WmsLayerParams): GeoLibreLayer {
  const endpoint = stripOgcOperationParams(params.endpoint.trim(), "WMS");
  const version = normalizeWmsVersion(params.version);
  const layers = params.layers.trim();
  const styles = params.styles.trim();
  const tileSize = toTileSize(params.tileSize);
  const tileUrl = createWmsTileUrl({
    endpoint,
    layers,
    styles,
    format: params.format,
    transparent: params.transparent,
    tileSize,
    version,
  });
  const attribution = attributionForTileUrl(tileUrl);
  return createBaseLayer(
    params.name,
    "wms",
    {
      type: "raster",
      tiles: [tileUrl],
      tileSize,
      url: endpoint,
      layers,
      styles,
      format: params.format,
      transparent: params.transparent,
      version,
      ...(attribution ? { attribution } : {}),
    },
    { service: "wms" },
  );
}

/** Reads the WMS fields from a saved entry, mirroring `WmsSource.applyFields`. */
export function wmsFieldsToParams(entry: ServiceLibraryEntry): WmsLayerParams {
  const { fields } = entry;
  const endpoint = serviceFieldString(fields, "endpoint");
  // A saved service predating the version field falls back to the endpoint's
  // own VERSION parameter (if any) rather than silently resetting to 1.1.1.
  const savedVersion = serviceFieldString(fields, "version");
  const detectedVersion = wmsVersionFromEndpoint(endpoint);
  return {
    name: entry.name,
    endpoint,
    layers: serviceFieldString(fields, "layers"),
    styles: serviceFieldString(fields, "styles"),
    format: serviceFieldString(fields, "format", "image/png"),
    transparent: serviceFieldBoolean(fields, "transparent", true),
    tileSize: serviceFieldString(fields, "tileSize", "256"),
    version: normalizeWmsVersion(savedVersion || detectedVersion || "1.1.1"),
  };
}

// --- WMTS ------------------------------------------------------------------

export interface WmtsLayerParams {
  name: string;
  url: string;
  tileSize: string;
}

/**
 * Builds a WMTS raster layer from a tile URL template, matching `WmtsSource`.
 *
 * @param params - The layer name, tile URL template, and tile size.
 * @returns The constructed WMTS layer.
 */
export function buildWmtsLayer(params: WmtsLayerParams): GeoLibreLayer {
  const url = params.url.trim();
  const attribution = attributionForTileUrl(url);
  return createBaseLayer(
    params.name,
    "wmts",
    {
      type: "raster",
      tiles: [url],
      tileSize: toTileSize(params.tileSize),
      url,
      ...(attribution ? { attribution } : {}),
    },
    { service: "wmts" },
  );
}

/** Reads the WMTS fields from a saved entry, mirroring `WmtsSource.applyFields`. */
export function wmtsFieldsToParams(entry: ServiceLibraryEntry): WmtsLayerParams {
  return {
    name: entry.name,
    url: serviceFieldString(entry.fields, "url"),
    tileSize: serviceFieldString(entry.fields, "tileSize", "256"),
  };
}

// --- WFS -------------------------------------------------------------------

/** A resolved WFS GetFeature request, ready for `fetchWfsGeoJson`. */
export interface WfsRequest {
  endpoint: string;
  typeName: string;
  version: string;
  outputFormat: string;
  srsName: string;
  maxFeatures: string | undefined;
}

/** Reads the WFS fields from a saved entry, mirroring `WfsSource`. */
export function wfsFieldsToRequest(entry: ServiceLibraryEntry): WfsRequest {
  const { fields } = entry;
  const maxFeatures = serviceFieldString(fields, "maxFeatures", "1000").trim();
  return {
    // Strip leftover operation params (a pasted GetCapabilities URL) so the
    // GetFeature request is not built with a conflicting duplicate REQUEST.
    endpoint: stripOgcOperationParams(serviceFieldString(fields, "endpoint").trim(), "WFS"),
    typeName: serviceFieldString(fields, "typeName").trim(),
    version: serviceFieldString(fields, "version", "2.0.0"),
    outputFormat: serviceFieldString(fields, "outputFormat", "application/json").trim(),
    srsName: serviceFieldString(fields, "srsName", "EPSG:4326").trim(),
    maxFeatures: maxFeatures || undefined,
  };
}

export interface WfsLayerParams {
  name: string;
  /** The GetFeature URL that actually returned GeoJSON (post output-format retry). */
  featureUrl: string;
  data: FeatureCollection;
  typeName: string;
  version: string;
  /** The output format that worked, which may differ from the requested one. */
  outputFormat: string;
  srsName: string;
}

/**
 * Builds a GeoJSON layer from fetched WFS GetFeature data, matching `WfsSource`'s
 * submit path (an embedded `geojson` collection and `sourcePath` alongside the
 * base record).
 *
 * @param params - The layer name, feature URL, fetched data, and WFS metadata.
 * @returns The constructed GeoJSON layer.
 */
export function buildWfsGeoJsonLayer(params: WfsLayerParams): GeoLibreLayer {
  return {
    ...createBaseLayer(
      params.name,
      "geojson",
      {
        type: "geojson",
        url: params.featureUrl,
        service: "wfs",
        typeName: params.typeName,
        version: params.version,
        outputFormat: params.outputFormat,
        srsName: params.srsName || undefined,
      },
      {
        featureCount: params.data.features.length,
        service: "wfs",
        sourceKind: "wfs-getfeature",
        typeName: params.typeName,
      },
    ),
    geojson: params.data,
    sourcePath: params.featureUrl,
  };
}

// --- ArcGIS ----------------------------------------------------------------

export interface ArcGISOptions {
  name: string;
  layerType: ArcGISLayerType;
  sourceType: ArcGISSourceType;
  url: string | undefined;
  itemId: string | undefined;
  portalUrl: string | undefined;
}

/** Reads the ArcGIS fields from a saved entry, mirroring `ArcGISSource`. */
export function arcgisFieldsToOptions(entry: ServiceLibraryEntry): ArcGISOptions {
  const { fields } = entry;
  return {
    name: entry.name,
    layerType:
      serviceFieldString(fields, "layerType") === "vector-tile" ? "vector-tile" : "feature",
    sourceType: serviceFieldString(fields, "sourceType") === "portal-item" ? "portal-item" : "url",
    url: serviceFieldString(fields, "url").trim() || undefined,
    itemId: serviceFieldString(fields, "itemId").trim() || undefined,
    portalUrl: serviceFieldString(fields, "portalUrl").trim() || undefined,
  };
}

// --- Dispatcher ------------------------------------------------------------

export interface ApplyServiceDeps {
  /** Store action to add the built layer. */
  addLayer: (layer: GeoLibreLayer, beforeLayerId?: string | null) => void;
  /** Map controller ref, used for the ArcGIS plugin path and to fit new layers. */
  mapControllerRef: RefObject<MapController | null>;
  /** Insert-before layer id, or null/undefined for the top of the stack. */
  beforeLayerId?: string | null;
}

/**
 * Adds a saved service-library entry to the map as a layer, resolving async
 * work (XYZ short-URL redirect, WFS GetFeature fetch) and delegating ArcGIS to
 * its plugin. This is the single entry point the Browser panel calls to load a
 * saved service in one click; the Add Data dialog keeps its own form-driven
 * submit but shares the pure builders above.
 *
 * The validation guards below throw plain English messages rather than `t()`
 * strings so this module stays React/i18n-free and importable under Node for
 * the unit tests. That is a deliberate boundary: the UI caller (the Browser
 * panel) owns translation — it surfaces these by catching and remapping on the
 * error's kind, or by validating the entry with `t()` before calling. The
 * messages are developer-facing fallbacks, not the user-visible copy.
 *
 * @param entry - The saved service to load.
 * @param deps - The store add action, map controller ref, and insert position.
 * @throws If the entry is missing or has an invalid required field.
 */
export async function applyServiceEntry(
  entry: ServiceLibraryEntry,
  deps: ApplyServiceDeps,
): Promise<void> {
  const { addLayer, mapControllerRef, beforeLayerId = null } = deps;

  switch (entry.kind) {
    case "xyz": {
      const request = xyzFieldsToRequest(entry.fields);
      if (!request.url.trim()) throw new Error("This service has no tile URL.");
      // xyz-url imports maplibre-gl at module load, so import it lazily to keep
      // this module's pure exports usable outside the browser (unit tests).
      const xyzUrl = await import("../../../lib/xyz-url");
      if (request.shortUrl) xyzUrl.registerXyzTileProtocol();
      const tileUrl = request.shortUrl
        ? await xyzUrl.resolveXyzTileUrlTemplate(request.url)
        : xyzUrl.createXyzTileUrlTemplate(request.url);
      addLayer(
        buildXyzLayer({
          name: entry.name,
          tileUrl,
          tileSize: request.tileSize,
          shortUrl: request.shortUrl,
        }),
        beforeLayerId,
      );
      return;
    }
    case "wms": {
      const params = wmsFieldsToParams(entry);
      if (!params.endpoint.trim()) throw new Error("This service has no URL.");
      if (!params.layers.trim()) {
        throw new Error("This service has no layers.");
      }
      addLayer(buildWmsLayer(params), beforeLayerId);
      return;
    }
    case "wmts": {
      const params = wmtsFieldsToParams(entry);
      if (!params.url.trim()) throw new Error("This service has no tile URL.");
      addLayer(buildWmtsLayer(params), beforeLayerId);
      return;
    }
    case "arcgis": {
      const options = arcgisFieldsToOptions(entry);
      const { createAppAPI } = await import("../../../hooks/usePlugins");
      const { addArcGISLayer } = await import("@geolibre/plugins");
      await addArcGISLayer(createAppAPI(mapControllerRef), {
        beforeLayerId,
        itemId: options.itemId,
        layerType: options.layerType,
        name: options.name,
        portalUrl: options.portalUrl,
        sourceType: options.sourceType,
        // Tokens are never persisted to the service library, so none is sent.
        token: undefined,
        url: options.url,
      });
      return;
    }
    case "wfs": {
      const request = wfsFieldsToRequest(entry);
      if (!request.endpoint) throw new Error("This service has no URL.");
      if (!request.typeName) throw new Error("This service has no feature type.");
      // Mirror WfsSource.handleSubmit's remaining guards: the save path
      // (ServiceLibrarySection) only validates the entry name, so a saved WFS
      // entry can carry an empty output format or a non-numeric max features.
      if (!request.outputFormat) {
        throw new Error("This service has no output format.");
      }
      if (request.maxFeatures && !Number.isFinite(Number(request.maxFeatures))) {
        throw new Error("This service's max features value is not numeric.");
      }
      const { fetchWfsGeoJson } = await import("../../../lib/layer-refresh");
      const { data, url, outputFormat } = await fetchWfsGeoJson(
        {
          endpoint: request.endpoint,
          typeName: request.typeName,
          version: request.version,
          outputFormat: request.outputFormat,
          srsName: request.srsName,
          maxFeatures: request.maxFeatures,
        },
        { useWfsProxy: true },
      );
      const layer = buildWfsGeoJsonLayer({
        name: entry.name,
        featureUrl: url,
        data,
        typeName: request.typeName,
        version: request.version,
        outputFormat,
        srsName: request.srsName,
      });
      addLayer(layer, beforeLayerId);
      mapControllerRef.current?.fitLayer(layer);
      return;
    }
    default: {
      // Exhaustiveness guard: a new ServiceLibraryKind must add a branch here.
      const exhaustive: never = entry.kind;
      throw new Error(`Unsupported service kind: ${String(exhaustive)}`);
    }
  }
}
