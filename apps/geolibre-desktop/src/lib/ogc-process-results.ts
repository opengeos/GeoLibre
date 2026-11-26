import { OgcProcessError } from "./ogc-process-errors";
import i18next from "i18next";
import { redactUrlCredentials, shouldZoomToNewLayers, useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI } from "@geolibre/plugins";
import { addRasterToMap } from "@geolibre/plugins/maplibre-raster";
import { downloadOgcProcessOutput, type OgcProcessOutput } from "./ogc-api-processes";
import { parseGeoJsonValue } from "./file-io/vector-text-formats";
import { uniqueLayerName } from "./unique-layer-name";
import { validOgcProcessGeoJson } from "./ogc-process-geometry";
import { isProcessJsonMediaType } from "./ogc-process-media-type";

/** Bounded display copy; large results stay intact for downloading and import. */
export function ogcProcessOutputPreview(output: OgcProcessOutput): string {
  if (output.href) return redactUrlCredentials(output.href);
  if (output.bytes)
    return i18next.t("processing.ogcProcesses.outputBytes", { count: output.bytes.byteLength });
  if (output.documentBytes) return new TextDecoder().decode(output.documentBytes.subarray(0, 2000));
  if (typeof output.value === "string") return output.value.slice(0, 2000);
  const shorten = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return value.slice(0, 300);
    if (!value || typeof value !== "object") return value;
    if (depth > 3) return "…";
    if (Array.isArray(value)) return value.slice(0, 5).map((item) => shorten(item, depth + 1));
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 12)
        .map(([key, item]) => [key, shorten(item, depth + 1)]),
    );
  };
  return (JSON.stringify(shorten(output.value, 0), null, 2) ?? "null").slice(0, 2000);
}

/** Literal messages stay downloadable; structured or referenced geodata can be imported. */
export function canImportOgcProcessOutput(output: OgcProcessOutput): boolean {
  if (output.completeDocument) return false;
  if (output.warning) return false;
  const mediaType = output.mediaType?.split(";", 1)[0].trim().toLowerCase();
  const unknownBinary = !mediaType || mediaType === "application/octet-stream";
  if (output.href || output.bytes)
    return (
      unknownBinary || isProcessJsonMediaType(mediaType ?? "") || /tiff/i.test(mediaType ?? "")
    );
  if (
    mediaType === "application/geo+json" ||
    mediaType === "application/vnd.geo+json" ||
    /tiff/i.test(mediaType ?? "")
  )
    return true;
  if (output.encoding === "base64" && (unknownBinary || isProcessJsonMediaType(mediaType ?? "")))
    return true;
  const value = output.value;
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [
      "FeatureCollection",
      "Feature",
      "Point",
      "MultiPoint",
      "LineString",
      "MultiLineString",
      "Polygon",
      "MultiPolygon",
      "GeometryCollection",
    ].includes(String((value as Record<string, unknown>).type))
  );
}

export function ogcProcessOutputFileName(id: string, mimeType: string): string {
  const type = mimeType.split(";", 1)[0].toLowerCase();
  const extension = /tiff/.test(type)
    ? "tif"
    : type === "application/geo+json"
      ? "geojson"
      : /json/.test(type)
        ? "json"
        : /csv/.test(type)
          ? "csv"
          : /xml/.test(type)
            ? "xml"
            : type.startsWith("text/")
              ? "txt"
              : "bin";
  return `${id.replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 100) || "result"}.${extension}`;
}

/** Import a fixed result snapshot, preserving numerical raster samples and project ownership. */
export async function importOgcProcessOutput(
  output: OgcProcessOutput,
  sourceUrl: string,
  app: GeoLibreAppAPI,
  signal: AbortSignal,
): Promise<string> {
  const project = useAppStore.getState().projectLoadCount;
  const inline =
    !output.href &&
    !output.bytes &&
    !output.encoding &&
    output.value !== null &&
    typeof output.value === "object";
  const blob = inline ? null : await downloadOgcProcessOutput(output, signal);
  signal.throwIfAborted();
  const header = blob ? new Uint8Array(await blob.slice(0, 4).arrayBuffer()) : new Uint8Array();
  const tiff =
    header.length === 4 &&
    ((header[0] === 73 && header[1] === 73 && [42, 43].includes(header[2])) ||
      (header[0] === 77 && header[1] === 77 && [42, 43].includes(header[3])));
  const metadata = {
    ogcProcessSnapshot: true,
    ogcProcessOutput: output.id,
    sourceUrl: redactUrlCredentials(sourceUrl),
  };
  const name = uniqueLayerName(
    i18next.t("processing.ogcProcesses.layerName", { id: output.id }),
    useAppStore.getState().layers,
  );
  if (tiff && blob) {
    const { convertGeoTiffToCog, readGeoTiffInfo } = await import("@geolibre/processing");
    let data = new Uint8Array(await blob.arrayBuffer());
    const info = await readGeoTiffInfo(data);
    if (!info.ok) throw new OgcProcessError("rasterUnreadable");
    // Both tiled readers and striped conversion ultimately expose Float64 values.
    if (info.bits_per_sample === 64 && info.sample_format !== "ieeefloat")
      throw new OgcProcessError("rasterPrecision");
    if (!info.tiled) {
      data = new Uint8Array(await convertGeoTiffToCog(data, { signal, float64: true }));
      const converted = await readGeoTiffInfo(data);
      if (
        (info.bits_per_sample > 8 || info.sample_format !== "uint") &&
        (converted.bits_per_sample !== 64 || converted.sample_format !== "ieeefloat")
      )
        throw new OgcProcessError("rasterPrecision");
    }
    signal.throwIfAborted();
    if (useAppStore.getState().projectLoadCount !== project)
      throw new DOMException("Project changed", "AbortError");
    const id = await addRasterToMap(
      app,
      new File([data], ogcProcessOutputFileName(output.id, "image/tiff"), { type: "image/tiff" }),
      { name, signal },
    );
    const state = useAppStore.getState();
    if (state.projectLoadCount === project) {
      const layer = state.layers.find((item) => item.id === id);
      if (layer) state.updateLayer(id, { metadata: { ...layer.metadata, ...metadata } });
    }
    return id;
  }
  let document: unknown;
  try {
    // Layer edits must never mutate the retained, downloadable result snapshot.
    document = inline ? structuredClone(output.value) : JSON.parse(await blob!.text());
  } catch {
    throw new OgcProcessError("geodataOnly");
  }
  const value =
    document && typeof document === "object" && !Array.isArray(document)
      ? (document as Record<string, unknown>)
      : undefined;
  const type = value?.type;
  const collection =
    type === "FeatureCollection"
      ? value
      : type === "Feature"
        ? {
            type: "FeatureCollection",
            features: [value],
            ...(value?.crs ? { crs: value.crs } : {}),
          }
        : typeof type === "string" &&
            [
              "Point",
              "MultiPoint",
              "LineString",
              "MultiLineString",
              "Polygon",
              "MultiPolygon",
              "GeometryCollection",
            ].includes(type)
          ? {
              type: "FeatureCollection",
              features: [{ type: "Feature", properties: {}, geometry: value }],
              ...(value?.crs ? { crs: value.crs } : {}),
            }
          : null;
  if (!collection) throw new OgcProcessError("geodataOnly");
  const data = await parseGeoJsonValue(collection);
  if (!validOgcProcessGeoJson(data)) throw new OgcProcessError("invalidGeometry");
  signal.throwIfAborted();
  const state = useAppStore.getState();
  if (state.projectLoadCount !== project) throw new DOMException("Project changed", "AbortError");
  const id = state.addGeoJsonLayer(name, data, undefined, null, { metadata });
  if (shouldZoomToNewLayers()) app.fitLayer?.(id);
  return id;
}
