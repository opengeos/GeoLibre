/**
 * KML and KMZ loading: placemark layers split by Folder and time, ground
 * overlays, `<Model>` meshes converted to GLB, and tiled Super-Overlays.
 *
 * Importing this module registers the Super-Overlay resolver that re-reads a
 * KMZ pyramid from disk when a saved project is reopened.
 */

import { hasPathTraversal } from "@geolibre/core";
import type { Feature, FeatureCollection } from "geojson";
import type { DuckDbVectorLoadOptions } from "../duckdb-vector-guard";
import type { DuckDbVectorFile } from "../duckdb-vector-loader";
import { isTauri } from "../is-tauri";
import {
  KML_FOLDER_PATH_PROPERTY,
  KML_TIME_PROPERTY,
  parseKmlGroundOverlays,
  parseKmlModels,
  parseKmlText,
  type KmlGroundOverlay,
  type KmlModel,
  type KmlTimeBounds,
} from "../kml";
import {
  findArchiveEntry,
  findArchiveEntryKey,
  imageMimeFromName,
  isTiffImageName,
  normalizeArchivePath,
} from "../kml-overlays";
import {
  registerKmlSuperOverlay,
  setKmlSuperOverlayResolver,
  unregisterKmlSuperOverlay,
  type KmlSuperOverlayTile,
} from "../kml-super-overlay";
import { tiffBytesToPngBytes } from "../tiff-image";
import type {
  LoadedImageOverlay,
  LoadedLayer,
  LoadedModel,
  LoadedVectorLayer,
} from "./loaded-layer";
import { readLocalFileBytes } from "./local-fs";
import {
  browserSafeFileName,
  fileBaseName,
  isAbsoluteLocalPath,
  isHttpUrl,
  isRestorableVectorPath,
  pathWithoutExtension,
} from "./paths";
import {
  isVectorLoadCancelled,
  loadDuckDbVector,
  mergeFeatureCollections,
  toDuckDbVectorData,
  unzipArchive,
} from "./vector-shared";

/**
 * Above this many foldered placemarks, a KML import stops giving each placemark
 * its own layer and merges them into one layer per `<Folder>` instead. Every
 * layer is a store mutation, a MapLibre source, and a Layers panel row, and the
 * cost grows faster than the count: an isosurface export of a few hundred
 * triangle placemarks froze the page for most of a minute (#2411).
 */
export const KML_PLACEMARK_LAYER_LIMIT = 50;

/**
 * The most layers a time-animated KML import may split into. Every time window
 * becomes at least one layer, so a file with more distinct times than this
 * loads as static layers rather than freezing the page the same way one layer
 * per placemark did (#2411).
 */
export const KML_TIME_FRAME_LAYER_LIMIT = 100;

/** A placemark with its internal KML import metadata read off and stripped. */
interface KmlPlacemarkEntry {
  feature: Feature;
  groupPath: string[];
  time: KmlTimeBounds | null;
  index: number;
}

/** Placemarks that end up in one layer. */
interface KmlPlacemarkBucket {
  entries: KmlPlacemarkEntry[];
  groupPath: string[];
  time: KmlTimeBounds | null;
}

function kmlTimeFromProperty(value: unknown): KmlTimeBounds | null {
  if (!value || typeof value !== "object") return null;
  const { begin, end } = value as { begin?: unknown; end?: unknown };
  return {
    begin: typeof begin === "number" && Number.isFinite(begin) ? begin : null,
    end: typeof end === "number" && Number.isFinite(end) ? end : null,
  };
}

/** A short UTC label for a frame start, e.g. "2024-01-01" or "2024-01-01 06:00". */
function kmlTimeLabel(begin: number): string {
  const iso = new Date(begin).toISOString();
  const [date, clock] = [iso.slice(0, 10), iso.slice(11, 19)];
  if (clock === "00:00:00") return date;
  return `${date} ${clock.endsWith(":00") ? clock.slice(0, 5) : clock}`;
}

/**
 * Split folder-aware KML placemarks into layers that can occupy distinct groups.
 *
 * Only placemarks that actually sit inside a `<Folder>` are split out;
 * everything else stays merged into a single layer, as it was before folder
 * support. A real-world export is often a handful of foldered placemarks among
 * hundreds of flat ones, and splitting those too would turn one cheap layer add
 * into hundreds of store mutations and layer-panel rows. For the same reason a
 * file with more than {@link KML_PLACEMARK_LAYER_LIMIT} foldered placemarks gets
 * one layer per Folder rather than one per placemark.
 *
 * Placemarks carrying a `<TimeSpan>`/`<TimeStamp>` (their own or inherited from
 * a Folder) with at least two distinct start times become Time Slider frames:
 * placemarks sharing a folder and a time window share a layer, and the layers
 * are sequenced like ground-overlay frames so only the first time step starts
 * visible.
 *
 * @param collection - Placemarks parsed by `parseKmlText`, still carrying the
 *   internal folder/time properties.
 * @param path - The source file path.
 * @returns The layers to add, in store insertion order.
 */
export function splitKmlFolderLayers(
  collection: FeatureCollection,
  path: string,
): LoadedVectorLayer[] {
  const hasImportMetadata = collection.features.some(
    (feature) =>
      Array.isArray(feature.properties?.[KML_FOLDER_PATH_PROPERTY]) ||
      feature.properties?.[KML_TIME_PROPERTY] != null,
  );
  if (!hasImportMetadata) return [{ data: collection, path }];

  const entries: KmlPlacemarkEntry[] = collection.features.map((feature, index) => {
    const properties = { ...(feature.properties ?? {}) };
    const rawPath = properties[KML_FOLDER_PATH_PROPERTY];
    const time = kmlTimeFromProperty(properties[KML_TIME_PROPERTY]);
    delete properties[KML_FOLDER_PATH_PROPERTY];
    delete properties[KML_TIME_PROPERTY];
    const groupPath = Array.isArray(rawPath)
      ? rawPath.filter((part): part is string => typeof part === "string" && part.trim() !== "")
      : [];
    return { feature: { ...feature, properties }, groupPath, time, index };
  });

  // Time only splits layers when the placemarks form an animation. A lone
  // time-tagged placemark, or a whole file under one inherited `<TimeSpan>`, is
  // not a sequence and stays an ordinary static layer.
  const begins = new Set(
    entries.flatMap((entry) => (typeof entry.time?.begin === "number" ? [entry.time.begin] : [])),
  );
  const perPlacemark =
    entries.filter((entry) => entry.groupPath.length > 0).length <= KML_PLACEMARK_LAYER_LIMIT;

  const planBuckets = (animated: boolean): Map<string, KmlPlacemarkBucket> => {
    // Map iteration keeps first-seen document order.
    const planned = new Map<string, KmlPlacemarkBucket>();
    for (const entry of entries) {
      const time = animated && typeof entry.time?.begin === "number" ? entry.time : null;
      const key =
        perPlacemark && entry.groupPath.length > 0
          ? `placemark:${entry.index}`
          : `${JSON.stringify(entry.groupPath)}|${time ? `${time.begin}|${time.end}` : ""}`;
      const bucket = planned.get(key);
      if (bucket) bucket.entries.push(entry);
      else planned.set(key, { entries: [entry], groupPath: entry.groupPath, time });
    }
    return planned;
  };

  let buckets = planBuckets(begins.size >= 2);
  if (begins.size >= 2 && buckets.size > KML_TIME_FRAME_LAYER_LIMIT) {
    // One layer per time window would bring back the per-layer freeze (e.g. a
    // GPS track with a `<TimeStamp>` on every point), so load the placemarks
    // as static layers instead.
    console.warn(
      `[GeoLibre] "${path}" has ${begins.size} distinct KML times, which would need ${buckets.size} layers; loading it without Time Slider animation (limit ${KML_TIME_FRAME_LAYER_LIMIT}).`,
    );
    buckets = planBuckets(false);
  }

  // A merged Folder layer stands in for the Folder itself (so it is not nested
  // in a group of the same name) unless the Folder also needs to be a group:
  // it has sub-folders of its own, or splits into several time frames.
  const folderKey = (groupPath: string[]) => JSON.stringify(groupPath);
  const bucketsPerFolder = new Map<string, number>();
  const ancestorFolders = new Set<string>();
  for (const { groupPath } of buckets.values()) {
    const key = folderKey(groupPath);
    bucketsPerFolder.set(key, (bucketsPerFolder.get(key) ?? 0) + 1);
    for (let depth = 1; depth < groupPath.length; depth += 1) {
      ancestorFolders.add(folderKey(groupPath.slice(0, depth)));
    }
  }

  const ungroupedLayers: LoadedVectorLayer[] = [];
  const folderLayers: LoadedVectorLayer[] = [];
  for (const bucket of buckets.values()) {
    const data: FeatureCollection = {
      type: "FeatureCollection",
      features: bucket.entries.map((entry) => entry.feature),
    };
    const timeSpan = bucket.time ? { timeSpan: { ...bucket.time } } : {};
    const timeLabel = typeof bucket.time?.begin === "number" ? kmlTimeLabel(bucket.time.begin) : "";
    if (bucket.groupPath.length === 0) {
      // The untimed merged layer carries no name so the import falls back to
      // the file name; a time frame is named by its start.
      ungroupedLayers.push({ data, path, ...(timeLabel ? { name: timeLabel } : {}), ...timeSpan });
      continue;
    }
    if (perPlacemark) {
      const [{ feature, index }] = bucket.entries;
      const name =
        typeof feature.properties?.name === "string" && feature.properties.name.trim() !== ""
          ? feature.properties.name
          : `Placemark ${index + 1}`;
      folderLayers.push({ data, name, path, groupPath: bucket.groupPath, ...timeSpan });
      continue;
    }
    const key = folderKey(bucket.groupPath);
    const folderName = bucket.groupPath[bucket.groupPath.length - 1];
    const standsInForFolder = bucketsPerFolder.get(key) === 1 && !ancestorFolders.has(key);
    folderLayers.push({
      data,
      name: timeLabel && !standsInForFolder ? `${folderName} ${timeLabel}` : folderName,
      path,
      groupPath: standsInForFolder ? bucket.groupPath.slice(0, -1) : bucket.groupPath,
      ...timeSpan,
    });
  }

  // Store insertion is top-first, so feed layers in reverse document order to
  // keep their visible layer/group order aligned with Google Earth. The
  // ungrouped placemarks are added first so they settle below the folders.
  return sequenceTimeFrames([...ungroupedLayers.reverse(), ...folderLayers.reverse()]);
}

function readKmlEntries(entries: Record<string, Uint8Array>): DuckDbVectorFile[] {
  const kmlEntries = Object.entries(entries)
    .filter(([entryName]) => entryName.toLowerCase().endsWith(".kml"))
    .sort(([leftName], [rightName]) => {
      if (browserSafeFileName(leftName).toLowerCase() === "doc.kml") return -1;
      if (browserSafeFileName(rightName).toLowerCase() === "doc.kml") return 1;
      return leftName.localeCompare(rightName);
    });

  if (!kmlEntries.length) {
    throw new Error("The KMZ archive did not contain a KML file.");
  }

  return kmlEntries.map(([entryName, data], index) => {
    const entryBaseName = browserSafeFileName(entryName) || `document-${index + 1}.kml`;
    return {
      name: kmlEntries.length === 1 ? entryBaseName : `${index + 1}-${entryBaseName}`,
      extension: "kml",
      data: toDuckDbVectorData(data),
    };
  });
}

async function readKmzKmlFiles(data: ArrayBuffer | Uint8Array): Promise<DuckDbVectorFile[]> {
  return readKmlEntries(await unzipArchive(data));
}

/**
 * Encode raw image bytes as a `data:` URL. Uses a `Blob` + `FileReader` (rather
 * than `btoa`) so a large overlay image cannot overflow the argument stack.
 */
function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Could not read overlay image."));
    reader.readAsDataURL(new Blob([bytes as BlobPart], { type: mime }));
  });
}

function imageOverlayLayer(
  overlay: KmlGroundOverlay,
  url: string,
  path: string,
): LoadedImageOverlay {
  return {
    kind: "image-overlay",
    // Strip the file extension for the fallback name (e.g. "tour.kmz" ->
    // "tour overlay"), matching how the vector layers are named.
    name: overlay.name?.trim() || `${pathWithoutExtension(fileBaseName(path))} overlay`,
    path,
    url,
    coordinates: overlay.coordinates,
    bounds: overlay.bounds,
    opacity: overlay.opacity,
    ...(overlay.time ? { timeSpan: overlay.time } : {}),
  };
}

/** A layer record that can be a frame of a time-animated KML sequence. */
interface TimeFrameCandidate {
  timeSpan?: { begin: number | null; end: number | null };
  groupId?: string;
  visible?: boolean;
}

/**
 * Turn the time-tagged layers in a set into an animation: sort them by start
 * time, fill an open `<TimeStamp>`/`<TimeSpan>` end with the next later frame's
 * start (a step function), give them a shared group id, and leave only the
 * first time step visible so the others do not all stack at once before the
 * Time Slider is opened. Frames sharing a start time (e.g. two folders tagged
 * with the same `<TimeSpan>`) step together.
 *
 * Only layers with a numeric start (`timeSpan.begin`) are treated as frames,
 * matching what the Time Slider can animate; a layer with an open-start span
 * (or a lone time-tagged layer that is not part of a sequence) has its
 * transient `timeSpan` dropped so it stays a normal static layer the slider
 * never hides.
 *
 * @param layers - The resolved ground overlays or placemark layers for one
 *   file, mutated in place.
 * @returns The same array, for chaining.
 */
export function sequenceTimeFrames<T extends TimeFrameCandidate>(layers: T[]): T[] {
  const frames = layers
    .filter(
      (layer): layer is T & { timeSpan: { begin: number; end: number | null } } =>
        typeof layer.timeSpan?.begin === "number",
    )
    .sort((a, b) => a.timeSpan.begin - b.timeSpan.begin);

  // An animation needs at least two frames with distinct start times. A lone
  // time-tagged layer, or several sharing one time (e.g. a single inherited
  // Folder `<TimeSpan>`), is not a sequence; strip every transient timeSpan so
  // the Time Slider treats these layers as ordinary static layers.
  const begins = [...new Set(frames.map((frame) => frame.timeSpan.begin))];
  if (begins.length < 2) {
    for (const layer of layers) delete layer.timeSpan;
    return layers;
  }

  const inSequence = new Set<T>(frames);
  const groupId = crypto.randomUUID();
  for (const frame of frames) {
    frame.groupId = groupId;
    frame.visible = frame.timeSpan.begin === begins[0];
    // A frame with an open end runs until the next time step begins (or stays
    // open for the last step), so an instant-tagged sequence steps cleanly.
    if (frame.timeSpan.end === null) {
      const next = begins.find((begin) => begin > frame.timeSpan.begin);
      if (typeof next === "number") frame.timeSpan.end = next;
    }
  }
  // Any time-tagged layer left out of the sequence (e.g. an open-start span)
  // should not be animated, so drop its timeSpan too.
  for (const layer of layers) {
    if (!inSequence.has(layer)) delete layer.timeSpan;
  }
  return layers;
}

// A ground-overlay image is inlined as a base64 `data:` URL on the layer and
// persisted in the project file (and every collaboration snapshot) at ~4/3 its
// byte size, so cap it like the Raster Georeferencer does to avoid bloating
// projects and memory.
const MAX_OVERLAY_IMAGE_BYTES = 8 * 1024 * 1024;

// A `<GroundOverlay>` together with the archive directory of the KML that
// declared it, so a relative `href` can be resolved against that directory
// first.
interface KmzOverlay {
  overlay: KmlGroundOverlay;
  baseDir: string;
}

// The directory prefix (with trailing slash) of an archive entry name, or "".
function archiveDirname(entryName: string): string {
  const slash = entryName.lastIndexOf("/");
  return slash >= 0 ? entryName.slice(0, slash + 1) : "";
}

// Resolve every GroundOverlay in the archive's KML documents to an image layer,
// pulling each overlay's image bytes out of the archive (or using an absolute
// URL directly). An archive-embedded TIFF is transcoded to PNG first, since no
// browser can paint TIFF. Overlays whose image is missing, oversized, or in a
// format browsers cannot render are skipped with a warning.
async function groundOverlaysFromKmz(
  entries: Record<string, Uint8Array>,
  kmlDocs: { name: string; text: string }[],
  path: string,
): Promise<LoadedImageOverlay[]> {
  // Prefilter (case-insensitively, matching kml.ts's tolerant element matching)
  // so a KML with no overlay is not DOM-parsed a second time.
  const parsed: KmzOverlay[] = kmlDocs
    .filter((doc) => /groundoverlay/i.test(doc.text))
    .flatMap((doc) =>
      parseKmlGroundOverlays(doc.text).map((overlay) => ({
        overlay,
        baseDir: archiveDirname(doc.name),
      })),
    )
    .sort((a, b) => a.overlay.drawOrder - b.overlay.drawOrder);

  const overlays: LoadedImageOverlay[] = [];
  for (const { overlay, baseDir } of parsed) {
    if (isHttpUrl(overlay.href)) {
      if (isRemoteTiffOverlay(overlay.href)) continue;
      overlays.push(imageOverlayLayer(overlay, overlay.href.trim(), path));
      continue;
    }
    // Try the href relative to its KML's directory first (a KMZ nesting
    // `folder/doc.kml` referencing `images/x.png` means `folder/images/x.png`),
    // then fall back to the global archive lookup.
    const data =
      findArchiveEntry(entries, baseDir + overlay.href) ?? findArchiveEntry(entries, overlay.href);
    if (!data) {
      console.warn(
        `Skipping a KML ground overlay: its image "${overlay.href}" was not found in the KMZ archive.`,
      );
      continue;
    }
    if (isOverlayImageTooLarge(data, overlay.href)) continue;

    // Global Mapper and gdal2tiles both write `.tif` overlay images, which no
    // browser can decode, so re-encode them as PNG. The PNG is what gets
    // inlined, so it is size-checked in turn: a compressed TIFF can transcode
    // into a much larger file.
    let image = data;
    let mime = imageMimeFromName(overlay.href);
    if (isTiffImageName(overlay.href)) {
      try {
        image = await tiffBytesToPngBytes(data);
      } catch (error) {
        console.warn(
          `Skipping a KML ground overlay: its TIFF image "${overlay.href}" could not be decoded.`,
          error,
        );
        continue;
      }
      if (isOverlayImageTooLarge(image, overlay.href)) continue;
      mime = "image/png";
    }
    overlays.push(imageOverlayLayer(overlay, await bytesToDataUrl(image, mime), path));
  }
  return sequenceTimeFrames(overlays);
}

// Whether an overlay's image is a TIFF that lives at an absolute URL. Unlike an
// archive-embedded TIFF, which is transcoded to PNG on import, a remote one
// cannot be re-encoded: fetching it needs CORS the overlay host rarely grants,
// and MapLibre would be handed a URL no browser can paint.
function isRemoteTiffOverlay(href: string): boolean {
  if (!isTiffImageName(href)) return false;
  console.warn(
    `Skipping a KML ground overlay: browsers cannot render the remote TIFF image "${href}".`,
  );
  return true;
}

// Whether an overlay image is over the inline limit, warning when it is.
function isOverlayImageTooLarge(image: Uint8Array, href: string): boolean {
  if (image.length <= MAX_OVERLAY_IMAGE_BYTES) return false;
  console.warn(
    `Skipping a KML ground overlay: its image "${href}" is ${Math.round(
      image.length / (1024 * 1024),
    )} MB, over the ${Math.round(MAX_OVERLAY_IMAGE_BYTES / (1024 * 1024))} MB inline limit.`,
  );
  return true;
}

// Order overlays by KML `<drawOrder>` ascending. Layers added later render on
// top (higher store index sits above), so emitting the lowest drawOrder first
// makes the highest drawOrder end up on top, matching Google Earth's stacking.
function sortByDrawOrder(overlays: KmlGroundOverlay[]): KmlGroundOverlay[] {
  return [...overlays].sort((a, b) => a.drawOrder - b.drawOrder);
}

// GroundOverlays in a standalone (non-archived) KML can only be resolved when
// their href is an absolute URL; a relative path needs the sibling image files
// a browser load does not have.
export function groundOverlaysFromKml(text: string, path: string): LoadedImageOverlay[] {
  // Cheap prefilter so a KML with no overlays is not DOM-parsed a second time
  // (its placemarks are already parsed by the vector loader). Matched
  // case-insensitively, like kml.ts's element matching, so non-conformant
  // casing is not dropped.
  if (!/groundoverlay/i.test(text)) return [];
  const overlays: LoadedImageOverlay[] = [];
  for (const overlay of sortByDrawOrder(parseKmlGroundOverlays(text))) {
    if (!isHttpUrl(overlay.href)) {
      console.warn(
        `Skipping a KML ground overlay: its image "${overlay.href}" is a relative path, which a standalone KML (unlike a KMZ) cannot resolve. Only absolute URLs are supported.`,
      );
      continue;
    }
    if (isRemoteTiffOverlay(overlay.href)) continue;
    overlays.push(imageOverlayLayer(overlay, overlay.href.trim(), path));
  }
  return sequenceTimeFrames(overlays);
}

// A KML `<Model>` GLB is inlined as a base64 `data:` URL on the layer (textures
// embedded) and persisted in the project file at ~4/3 its byte size, so cap it
// to avoid bloating projects and memory.
const MAX_MODEL_GLB_BYTES = 24 * 1024 * 1024;

// Cap the raw `.dae` source too, so an enormous mesh is rejected up front rather
// than after the expensive parse/normal-compute/export. COLLADA is verbose XML,
// so the source limit is more generous than the GLB output limit.
const MAX_DAE_SOURCE_BYTES = 64 * 1024 * 1024;

// The display name for a model layer. An unnamed `<Model>` falls back to a
// path-derived name; when a file has several such models the 1-based `index`
// disambiguates them so they are not all named identically. This resolves the
// name once here at load time; `kmlModelDisplayName` (kml-model.ts) is the
// downstream reader whose own fallback is only a defensive/test-time path.
function kmlModelName(model: KmlModel, path: string, index: number, total: number): string {
  const named = model.name?.trim();
  if (named) return named;
  const base = `${pathWithoutExtension(fileBaseName(path))} model`;
  return total > 1 ? `${base} ${index + 1}` : base;
}

function kmlModelLayer(
  model: KmlModel,
  converted: {
    url: string;
    radiusMeters: number;
    verticalMinMeters: number;
    verticalMaxMeters: number;
  },
  path: string,
  index: number,
  total: number,
): LoadedModel {
  return {
    kind: "model",
    name: kmlModelName(model, path, index, total),
    path,
    url: converted.url,
    longitude: model.longitude,
    latitude: model.latitude,
    altitude: model.altitude,
    heading: model.heading,
    tilt: model.tilt,
    roll: model.roll,
    scale: model.scale,
    radiusMeters: converted.radiusMeters,
    verticalMinMeters: converted.verticalMinMeters,
    verticalMaxMeters: converted.verticalMaxMeters,
  };
}

// Convert a COLLADA `.dae` (as text) to a self-contained GLB data URL, resolving
// any textures the DAE references. `resolveTexture` maps a raw texture path to a
// blob URL of an archive entry (for a KMZ); the created blob URLs are revoked
// once the GLTF exporter has embedded the pixels. Returns null on failure so one
// bad model does not abort the rest of the load.
async function daeToGlbDataUrl(
  daeText: string,
  href: string,
  resolveTexture?: (path: string) => Uint8Array | undefined,
  basePath = "",
): Promise<{
  url: string;
  radiusMeters: number;
  verticalMinMeters: number;
  verticalMaxMeters: number;
} | null> {
  const blobUrls: string[] = [];
  const modifier = resolveTexture
    ? (url: string): string | undefined => {
        const bytes = resolveTexture(url);
        if (!bytes) return undefined;
        const blob = URL.createObjectURL(
          new Blob([bytes as BlobPart], { type: imageMimeFromName(url) }),
        );
        blobUrls.push(blob);
        return blob;
      }
    : undefined;
  try {
    const { convertDaeToGlb } = await import("../collada-to-glb");
    const { glb, radiusMeters, verticalMinMeters, verticalMaxMeters } = await convertDaeToGlb(
      daeText,
      modifier,
      basePath,
    );
    if (glb.length > MAX_MODEL_GLB_BYTES) {
      console.warn(
        `Skipping a KML model: "${href}" converts to ${Math.round(
          glb.length / (1024 * 1024),
        )} MB, over the ${Math.round(MAX_MODEL_GLB_BYTES / (1024 * 1024))} MB inline limit.`,
      );
      return null;
    }
    const url = await bytesToDataUrl(glb, "model/gltf-binary");
    return { url, radiusMeters, verticalMinMeters, verticalMaxMeters };
  } catch (error) {
    console.warn(`Could not convert the KML model "${href}" to glTF.`, error);
    return null;
  } finally {
    for (const url of blobUrls) URL.revokeObjectURL(url);
  }
}

// Resolve the `<Model>` 3D models in an archive's KML documents. Each model's
// `.dae` is read from the archive (relative to its KML's directory) or fetched
// from an absolute URL, converted to a self-contained GLB, and returned as an
// image-free model descriptor. Models that cannot be resolved are skipped.
async function modelsFromKmz(
  entries: Record<string, Uint8Array>,
  kmlDocs: { name: string; text: string }[],
  path: string,
): Promise<LoadedModel[]> {
  const parsed = kmlDocs
    // `(?:\w+:)?` so a namespace-prefixed `<kml:Model>` (valid but rare) isn't
    // filtered out before `parseKmlModels` (which matches by localName) runs.
    .filter((doc) => /<(?:\w+:)?model[\s/>]/i.test(doc.text))
    .flatMap((doc) =>
      parseKmlModels(doc.text).map((model) => ({
        model,
        baseDir: archiveDirname(doc.name),
      })),
    );

  const models: LoadedModel[] = [];
  const total = parsed.length;
  for (const [index, { model, baseDir }] of parsed.entries()) {
    if (isHttpUrl(model.href)) {
      const converted = await fetchDaeAsGlbDataUrl(model.href);
      if (converted) models.push(kmlModelLayer(model, converted, path, index, total));
      continue;
    }
    const daeKey =
      findArchiveEntryKey(entries, baseDir + model.href) ??
      findArchiveEntryKey(entries, model.href);
    if (daeKey === undefined) {
      console.warn(
        `Skipping a KML model: its mesh "${model.href}" was not found in the KMZ archive.`,
      );
      continue;
    }
    const data = entries[daeKey];
    if (data.length > MAX_DAE_SOURCE_BYTES) {
      console.warn(
        `Skipping a KML model: its mesh "${model.href}" is ${Math.round(
          data.length / (1024 * 1024),
        )} MB, over the ${Math.round(MAX_DAE_SOURCE_BYTES / (1024 * 1024))} MB limit.`,
      );
      continue;
    }
    // Resolve textures relative to where the `.dae` was actually found (its
    // matched key), not the guessed `baseDir + href` — the basename fallback in
    // findArchiveEntryKey can match a differently-nested entry. Fall back to a
    // bare basename for textures stored elsewhere in the archive.
    const daeDir = archiveDirname(normalizeArchivePath(daeKey));
    const resolveTexture = (texturePath: string): Uint8Array | undefined => {
      const bytes =
        findArchiveEntry(entries, daeDir + texturePath) ?? findArchiveEntry(entries, texturePath);
      // Cap a single packaged texture (same limit as ground-overlay images) so
      // an oversized bundled image can't blow up the decode/GPU upload before
      // the GLB-size cap ever measures the result; skip it (untextured) instead.
      if (bytes && bytes.length > MAX_OVERLAY_IMAGE_BYTES) {
        console.warn(
          `Skipping a KML model texture "${texturePath}": ${Math.round(
            bytes.length / (1024 * 1024),
          )} MB, over the ${Math.round(MAX_OVERLAY_IMAGE_BYTES / (1024 * 1024))} MB limit.`,
        );
        return undefined;
      }
      return bytes;
    };
    const converted = await daeToGlbDataUrl(
      new TextDecoder("utf-8").decode(data),
      model.href,
      resolveTexture,
    );
    if (converted) models.push(kmlModelLayer(model, converted, path, index, total));
  }
  return models;
}

// Fetch an absolute-URL `.dae`, convert it to a GLB data URL. Textures resolve
// against the mesh's URL directory (best effort; a CORS-blocked fetch is
// skipped). Returns null on any failure.
async function fetchDaeAsGlbDataUrl(href: string): Promise<{
  url: string;
  radiusMeters: number;
  verticalMinMeters: number;
  verticalMaxMeters: number;
} | null> {
  try {
    // Bound the fetch so an unresponsive host can't hang the whole KML/KMZ load
    // (models are resolved sequentially), mirroring the texture-load timeout.
    const response = await fetch(href, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      console.warn(`Skipping a KML model: fetching "${href}" returned ${response.status}.`);
      return null;
    }
    // Best-effort size guard before buffering the whole body (mirrors the
    // Content-Length pre-check in `openRecentProjectFile`). A chunked response
    // with no Content-Length still falls through to the post-read check below.
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > MAX_DAE_SOURCE_BYTES) {
      console.warn(
        `Skipping a KML model: "${href}" is ${Math.round(
          Number(contentLength) / (1024 * 1024),
        )} MB, over the ${Math.round(MAX_DAE_SOURCE_BYTES / (1024 * 1024))} MB limit.`,
      );
      return null;
    }
    const daeText = await response.text();
    // Measure real byte size (not UTF-16 code units) so the cap matches the
    // archive path's `Uint8Array.length` check.
    const daeBytes = new Blob([daeText]).size;
    if (daeBytes > MAX_DAE_SOURCE_BYTES) {
      console.warn(
        `Skipping a KML model: "${href}" is ${Math.round(
          daeBytes / (1024 * 1024),
        )} MB, over the ${Math.round(MAX_DAE_SOURCE_BYTES / (1024 * 1024))} MB limit.`,
      );
      return null;
    }
    const basePath = href.slice(0, href.lastIndexOf("/") + 1);
    return await daeToGlbDataUrl(daeText, href, undefined, basePath);
  } catch (error) {
    console.warn(`Skipping a KML model: could not fetch "${href}".`, error);
    return null;
  }
}

// Models in a standalone (non-archived) KML can only be resolved when the mesh
// href is an absolute URL; a relative path needs the archive's packaged files.
export async function modelsFromKml(text: string, path: string): Promise<LoadedModel[]> {
  // `(?:\w+:)?` so a namespace-prefixed `<kml:Model>` isn't skipped before
  // `parseKmlModels` (which matches by localName) runs.
  if (!/<(?:\w+:)?model[\s/>]/i.test(text)) return [];
  const parsed = parseKmlModels(text);
  const models: LoadedModel[] = [];
  for (const [index, model] of parsed.entries()) {
    if (!isHttpUrl(model.href)) {
      console.warn(
        `Skipping a KML model: its mesh "${model.href}" is a relative path, which a standalone KML (unlike a KMZ) cannot resolve. Only absolute URLs are supported.`,
      );
      continue;
    }
    const converted = await fetchDaeAsGlbDataUrl(model.href);
    if (converted) models.push(kmlModelLayer(model, converted, path, index, parsed.length));
  }
  return models;
}

// Merge the vector placemarks from every KML in an archive, tolerating entries
// with no readable vector content (returning an empty collection) so an
// overlay-only archive still loads its overlays. Declining an oversized entry
// drops just that entry, matching `parseKmz`; the cancellation only propagates
// (skipping the whole archive) when every entry was declined and nothing else
// loaded.
async function kmzVectorFeatures(
  kmlFiles: DuckDbVectorFile[],
  entries: Record<string, Uint8Array>,
  options?: DuckDbVectorLoadOptions,
): Promise<FeatureCollection> {
  let cancellation: unknown;
  const settled = await Promise.all(
    kmlFiles.map((file) =>
      loadKmlFile(file, options).then(
        async (collection): Promise<FeatureCollection | null> => {
          await resolveKmzFeatureIcons(collection, entries, file.name);
          return collection;
        },
        (error): null => {
          if (isVectorLoadCancelled(error)) {
            cancellation = error;
            return null;
          }
          console.warn(
            "Could not read vector features from a KML entry in the KMZ archive.",
            error,
          );
          return null;
        },
      ),
    ),
  );
  const collections = settled.filter(
    (collection): collection is FeatureCollection => collection !== null,
  );
  if (collections.length === 0 && cancellation) throw cancellation;
  return mergeFeatureCollections(collections);
}

const KML_ICON_HREF_PROPERTY = "__geolibre_kml_icon_href";
const KML_ICON_URL_PROPERTY = "__geolibre_kml_icon_url";

/** Replace archive-relative KML icon hrefs with persistent inline raster URLs. */
async function resolveKmzFeatureIcons(
  collection: FeatureCollection,
  entries: Record<string, Uint8Array>,
  kmlEntryName: string,
): Promise<void> {
  const resolved = new Map<string, Promise<string | null>>();
  const iconUrl = (href: string): Promise<string | null> => {
    const cached = resolved.get(href);
    if (cached) return cached;
    const promise = (async () => {
      const key = findArchiveEntryKey(entries, resolveArchiveRelativeHref(kmlEntryName, href));
      if (!key) {
        console.warn(`Could not resolve embedded KMZ icon: ${href}`);
        return null;
      }
      const mime = imageMimeFromName(key);
      if (!mime.startsWith("image/") || mime === "image/svg+xml") return null;
      if (entries[key].byteLength > MAX_OVERLAY_IMAGE_BYTES) {
        console.warn(`Skipping oversized embedded KMZ icon: ${key}`);
        return null;
      }
      return bytesToDataUrl(entries[key], mime);
    })();
    resolved.set(href, promise);
    return promise;
  };

  await Promise.all(
    collection.features.map(async (feature) => {
      const properties = feature.properties;
      const href = properties?.[KML_ICON_HREF_PROPERTY];
      if (!properties || typeof href !== "string") return;
      const url = await iconUrl(href);
      delete properties[KML_ICON_HREF_PROPERTY];
      if (url) properties[KML_ICON_URL_PROPERTY] = url;
    }),
  );
}

function resolveArchiveRelativeHref(owner: string, href: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return href;
  const parts = href.startsWith("/") ? [] : owner.replaceAll("\\", "/").split("/").slice(0, -1);
  for (const part of href.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/**
 * Load a KMZ archive into its layers: the merged vector placemarks (when any)
 * plus every resolvable `<GroundOverlay>` as an image overlay. Throws only when
 * the archive yields neither, so a placemark-only, overlay-only, or mixed KMZ
 * all load correctly.
 */
export async function loadKmzLayers(
  data: ArrayBuffer | Uint8Array,
  path: string,
  options?: DuckDbVectorLoadOptions,
): Promise<LoadedLayer[]> {
  const entries = await unzipArchive(data);
  const kmlFiles = readKmlEntries(entries);

  // Decode the KML text up front, keeping each entry's full archive name so an
  // overlay href can resolve relative to its KML's directory. Reading from
  // `entries` (not the copies in `kmlFiles`) also avoids the DuckDB-WASM
  // fallback transferring/detaching a KML buffer before overlays are parsed.
  const kmlDocs = readKmlDocs(entries);

  // A Super-Overlay is a linked raster pyramid, not thousands of independent
  // persistent image layers, so it becomes one lazy tile source instead. The
  // `<Region>` + `<NetworkLink>` shape it is detected by is also how a plain
  // *vector* regionated KML is built, so the pyramid is only claimed once its
  // raster tiles actually resolve; anything else falls through to the normal
  // overlay/vector parse below rather than failing the whole import.
  // A pyramid node is a KML doc carrying a `<Region>`, and its overlays are that
  // level's tiles. The grain is deliberately the document, not the element: KML
  // attaches a `<Region>` to the enclosing Feature, so a gdal2tiles node's
  // `<GroundOverlay>` is the Region's *sibling*, and filtering by containment
  // would reject every real tile. A doc with no Region holds no tiles, so its
  // overlays (a legend, an inset, a full-extent image) load as their own image
  // layers instead of being given a pyramid level and folded into its bounds.
  // The residual gap is a hand-composed node that bundles an unrelated overlay
  // beside its tile; that one would still be swept in.
  const pyramidDocs = looksLikeSuperOverlay(kmlDocs) ? superOverlayDocNames(kmlDocs) : new Set();
  const superOverlayTiles = pyramidDocs.size
    ? superOverlayTilesFromKmz(
        entries,
        kmlDocs.filter((doc) => pyramidDocs.has(doc.name)),
      )
    : [];
  if (superOverlayTiles.length > 0) {
    const source = await registerKmlSuperOverlay(superOverlayTiles, {
      // Keyed by the source file, so the tile URL saved into a project resolves
      // again after `kmlSuperOverlayResolver` re-reads the KMZ on reopen. A
      // browser File has no re-readable path and gets a session-only key.
      ...(isAbsoluteLocalPath(path) ? { key: path } : {}),
    });
    try {
      // A composite export can carry standalone overlays, placemarks, or models
      // alongside its raster pyramid; returning only the tile layer would
      // silently drop them. The standalone overlays draw above the imagery.
      const plainDocs = kmlDocs.filter((doc) => !pyramidDocs.has(doc.name));
      const layers: LoadedLayer[] = [
        {
          kind: "kml-super-overlay",
          name: `${pathWithoutExtension(fileBaseName(path))} Super-Overlay`,
          path,
          ...source,
        },
        ...(plainDocs.length > 0 ? await groundOverlaysFromKmz(entries, plainDocs, path) : []),
        ...(options?.skipModels ? [] : await modelsFromKmz(entries, kmlDocs, path)),
      ];
      const placemarkEntries = placemarkKmlEntries(entries, kmlDocs);
      if (placemarkEntries) {
        try {
          const features = await kmzVectorFeatures(
            readKmlEntries(placemarkEntries),
            entries,
            options,
          );
          if (features.features.length > 0) {
            layers.push(...splitKmlFolderLayers(features, path));
          }
        } catch (error) {
          // Declining the oversized-vector prompt must not throw away the
          // pyramid, which is already registered and loads on its own.
          if (!isVectorLoadCancelled(error)) throw error;
        }
      }
      return layers;
    } catch (error) {
      // The caller never gets the layer, so nothing will ever reference the
      // tile URL — and an archive that never goes live is never pruned. Free
      // it here or a failed import (e.g. an unreadable bundled `.dae`) pins
      // the whole pyramid's bytes for the session.
      unregisterKmlSuperOverlay(source.url);
      throw error;
    }
  }

  // Ground overlays are drawn under vector placemarks (as in Google Earth), so
  // they are added first: a later store index renders on top. 3D models render
  // in the deck.gl overlay (always above MapLibre layers), so their array order
  // does not affect stacking.
  const layers: LoadedLayer[] = [
    ...(await groundOverlaysFromKmz(entries, kmlDocs, path)),
    // Skip the expensive COLLADA→GLB conversion when the caller only wants
    // vector features (e.g. re-reading a referenced local layer on reopen).
    ...(options?.skipModels ? [] : await modelsFromKmz(entries, kmlDocs, path)),
  ];

  // Declining the oversized-vector prompt must not throw away the archive's
  // ground overlays, so catch the cancellation and keep them; it is only
  // re-thrown at the end when nothing else loaded (so the caller still skips a
  // purely-declined file rather than surfacing a generic error).
  let cancellation: unknown;
  try {
    const features = await kmzVectorFeatures(kmlFiles, entries, options);
    if (features.features.length > 0) layers.push(...splitKmlFolderLayers(features, path));
  } catch (error) {
    if (!isVectorLoadCancelled(error)) throw error;
    cancellation = error;
  }

  if (layers.length === 0) {
    if (cancellation) throw cancellation;
    throw new Error(
      "The KMZ archive did not contain readable placemarks, ground overlays, or 3D models.",
    );
  }
  return layers;
}

interface KmlDoc {
  name: string;
  text: string;
}

// `(?:\w+:)?` so a namespace-prefixed `<kml:Region>` (valid but rare) still
// matches, mirroring the model filter in `modelsFromKmz`.
const KML_REGION = /<(?:\w+:)?Region(?:\s|>)/i;
const KML_NETWORK_LINK = /<(?:\w+:)?NetworkLink(?:\s|>)/i;
const KML_PLACEMARK = /<(?:\w+:)?Placemark(?:\s|>)/i;

function readKmlDocs(entries: Record<string, Uint8Array>): KmlDoc[] {
  return Object.entries(entries)
    .filter(([name]) => name.toLowerCase().endsWith(".kml"))
    .map(([name, bytes]) => ({
      name,
      text: new TextDecoder("utf-8").decode(bytes),
    }));
}

/**
 * Whether an archive has the shape of a Super-Overlay: several KML nodes, at
 * least one carrying both a `<Region>` and a `<NetworkLink>`. Regionated
 * *vector* KML is built the same way, so this only narrows the candidates —
 * the caller confirms the pyramid by resolving its raster tiles.
 */
function looksLikeSuperOverlay(kmlDocs: KmlDoc[]): boolean {
  return (
    kmlDocs.length > 1 &&
    kmlDocs.some((doc) => KML_REGION.test(doc.text) && KML_NETWORK_LINK.test(doc.text))
  );
}

/**
 * The names of the KML nodes that make up the pyramid: every node carrying a
 * `<Region>`, plus everything those nodes link to transitively.
 *
 * Membership cannot be `<Region>` alone. A gdal2tiles-style export regionates
 * its *inner* nodes but writes the deepest level as a bare `<GroundOverlay>`
 * with no Region — issue #1598's sample has 1,256 regionated nodes and 3,640
 * such leaves — so keying on Region would leave every leaf tile to load as its
 * own persistent image layer (each one inlined as a data URL), which is enough
 * to hang the app, and would silently drop the pyramid's deepest zoom.
 * Following the `<NetworkLink>` graph instead claims exactly the nodes the
 * pyramid reaches, so an overlay in a node it never links to — a legend, an
 * inset, a full-extent image — still loads on its own.
 */
export function superOverlayDocNames(kmlDocs: KmlDoc[]): Set<string> {
  const byName = new Map<string, KmlDoc>();
  for (const doc of kmlDocs) byName.set(normalizeArchivePath(doc.name), doc);
  const linked = new Set<string>();
  const queue: KmlDoc[] = [];
  for (const doc of kmlDocs) {
    if (!KML_REGION.test(doc.text)) continue;
    linked.add(doc.name);
    queue.push(doc);
  }
  while (queue.length > 0) {
    const doc = queue.pop() as KmlDoc;
    for (const href of kmlNodeHrefs(doc.text)) {
      const target =
        byName.get(normalizeArchivePath(archiveDirname(doc.name) + href)) ??
        byName.get(normalizeArchivePath(href));
      if (!target || linked.has(target.name)) continue;
      linked.add(target.name);
      queue.push(target);
    }
  }
  return linked;
}

/**
 * The archive-local KML nodes an `<href>` in this document points at. Matching
 * on the extension rather than the enclosing element keeps this a text scan (a
 * pyramid holds thousands of nodes): a `<GroundOverlay>`'s own href names an
 * image, never another node.
 */
function kmlNodeHrefs(text: string): string[] {
  return [...text.matchAll(/<href>([^<]+)<\/href>/gi)]
    .map((match) => match[1].trim())
    .filter((href) => !isHttpUrl(href) && /\.kml$/i.test(normalizeArchivePath(href)));
}

/** Every archive-local `<GroundOverlay>` image in a KMZ, as pyramid tiles. */
function superOverlayTilesFromKmz(
  entries: Record<string, Uint8Array>,
  kmlDocs: KmlDoc[],
): KmlSuperOverlayTile[] {
  return kmlDocs.flatMap((doc) =>
    parseKmlGroundOverlays(doc.text).flatMap((overlay) => {
      // A remote tile is not archive-local, so it is not part of the pyramid
      // this protocol serves. TIFF tiles stay in: the protocol decodes them
      // through geotiff when it paints them.
      if (isHttpUrl(overlay.href)) return [];
      const data =
        findArchiveEntry(entries, archiveDirname(doc.name) + overlay.href) ??
        findArchiveEntry(entries, overlay.href);
      return data ? [{ overlay, bytes: data }] : [];
    }),
  );
}

/**
 * The archive with its placemark-free KML nodes dropped, or null when no node
 * holds a `<Placemark>`. Lets a Super-Overlay's supplementary vector content
 * still load, without sending the pyramid's thousands of NetworkLink-only
 * nodes through DuckDB.
 */
function placemarkKmlEntries(
  entries: Record<string, Uint8Array>,
  kmlDocs: KmlDoc[],
): Record<string, Uint8Array> | null {
  const withPlacemarks = new Set(
    kmlDocs.filter((doc) => KML_PLACEMARK.test(doc.text)).map((doc) => doc.name),
  );
  if (withPlacemarks.size === 0) return null;
  const kept = { ...entries };
  for (const doc of kmlDocs) {
    if (!withPlacemarks.has(doc.name)) delete kept[doc.name];
  }
  return kept;
}

// Only the tile URL of a Super-Overlay layer persists into a project, never the
// pyramid's bytes, so a reopened project re-reads them from the source KMZ the
// first time MapLibre asks the protocol for a tile. The path comes out of a
// saved project, so it is whitelisted exactly like `restoreLocalFileLayers`
// before anything is read off disk.
setKmlSuperOverlayResolver(async (path) => {
  if (
    !isTauri() ||
    !isAbsoluteLocalPath(path) ||
    hasPathTraversal(path) ||
    !isRestorableVectorPath(path)
  ) {
    return null;
  }
  const entries = await unzipArchive(await readLocalFileBytes(path));
  const docs = readKmlDocs(entries);
  const pyramidDocs = superOverlayDocNames(docs);
  return superOverlayTilesFromKmz(
    entries,
    docs.filter((doc) => pyramidDocs.has(doc.name)),
  );
});

export async function parseKmz(
  data: ArrayBuffer | Uint8Array,
  options?: DuckDbVectorLoadOptions,
): Promise<FeatureCollection> {
  const kmlFiles = await readKmzKmlFiles(data);
  // Load each KML independently so declining one large KML inside a multi-KML
  // archive drops just that layer instead of failing the whole KMZ (Promise.all
  // is fail-fast). Real load errors still reject and abort the archive.
  let cancellation: unknown;
  const settled = await Promise.all(
    kmlFiles.map((file) =>
      loadKmlFile(file, options).then(
        (collection): FeatureCollection | null => collection,
        (error): null => {
          if (!isVectorLoadCancelled(error)) throw error;
          cancellation = error;
          return null;
        },
      ),
    ),
  );
  const collections = settled.filter(
    (collection): collection is FeatureCollection => collection !== null,
  );
  // Every KML was declined: propagate the cancellation so the caller skips the
  // whole archive rather than adding an empty layer.
  if (collections.length === 0 && cancellation) throw cancellation;
  return mergeFeatureCollections(collections);
}

/**
 * Load one KML entry, preferring the styled in-house reader so embedded
 * symbology survives, and falling back to DuckDB/GDAL for KML the reader does
 * not cover (so geometry still loads, without the styling). Cancellation from
 * the DuckDB fallback is allowed to propagate.
 */
async function loadKmlFile(
  file: DuckDbVectorFile,
  options?: DuckDbVectorLoadOptions,
): Promise<FeatureCollection> {
  try {
    return parseKmlText(new TextDecoder("utf-8").decode(file.data));
  } catch {
    return loadDuckDbVector(file, options);
  }
}
