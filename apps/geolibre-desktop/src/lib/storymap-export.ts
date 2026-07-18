import type { FeatureCollection, Geometry } from "geojson";
import {
  extrusionColorValue,
  extrusionHeightValue,
  styleValue,
  type GeoLibreLayer,
  type MapProjection,
  type StoryMap,
} from "@geolibre/core";
import { sanitizeStoryHtml } from "./sanitize-html";
import {
  STORY_END_STEP_ID,
  STORY_GLOBAL_VIEW,
  STORY_INSET_STYLE_URL,
  STORY_START_STEP_ID,
} from "./storymap-constants";

export interface StoryMapExportOptions {
  storymap: StoryMap;
  /** MapLibre style URL used as the story basemap. */
  basemapStyleUrl: string;
  /** Project layers; only in-memory GeoJSON layers are inlined into the export. */
  layers: GeoLibreLayer[];
  /**
   * Map projection the exported page renders in. Mirrors the in-app projection
   * so a globe story stays a globe (and not 2D Mercator) once exported (#917).
   * Defaults to globe when omitted, matching the app default.
   */
  projection?: MapProjection;
  /**
   * Localized label for the chapter-list toggle button (title + aria-label).
   * Defaults to English when omitted so the export still works standalone.
   */
  navToggleLabel?: string;
}

interface InlineLayerExport {
  id: string;
  /** MapLibre source spec (a GeoJSON source, or a raster tile source). */
  source: Record<string, unknown>;
  layerSpec: Record<string, unknown>;
  /** GeoLibre layer-level opacity, combined with the style's per-geometry one. */
  layerOpacity: number;
  /**
   * Absolute opacity chapter 0 assigns this layer, or undefined when chapter 0
   * does not touch it (then the natural opacity applies). Mirrors the in-app
   * presenter's chapter 0 so the first frame is not blank (#950).
   */
  chapterZeroOpacity?: number;
}

/**
 * Minimal blank MapLibre style used when the project has no basemap style URL.
 *
 * Basemaps added through the Basemaps plugin are raster *layers* (inlined
 * below), not a style URL, so the project's `basemapStyleUrl` is empty. Passing
 * an empty string to MapLibre yields a blank page (#936); a valid blank style
 * lets the inlined raster basemap and overlays render on top.
 */
const BLANK_EXPORT_STYLE: Record<string, unknown> = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#ffffff" },
    },
  ],
};

/**
 * Build a self-contained MapLibre storytelling HTML document for a story map.
 *
 * The output mirrors the `opengeos/maplibre-gl-storymaps` template: a single
 * scroll-driven page that flies between chapter locations. Project GeoJSON
 * layers referenced by chapter opacity transitions are inlined so the exported
 * story behaves like the in-app preview without any external data files.
 *
 * @param options Story map, basemap style, and project layers to export.
 * @returns A complete HTML document as a string.
 */
export function buildStoryMapHtml(options: StoryMapExportOptions): string {
  const {
    storymap,
    basemapStyleUrl,
    layers,
    projection = "globe",
    navToggleLabel = "Toggle chapter list",
  } = options;

  // The template reads chapters[0] for the initial camera, so an empty story
  // cannot produce a working page. Callers gate this behind a chapter count,
  // but fail loudly if that ever slips.
  if (storymap.chapters.length === 0) {
    throw new Error("Cannot export a story map with no chapters.");
  }

  // Only inline layers that are actually referenced by a chapter transition or
  // that are visible GeoJSON layers, so the export stays focused on the story.
  // `referenced` (enter ∪ exit) drives which layers to inline.
  const referenced = new Set<string>();
  for (const chapter of storymap.chapters) {
    for (const change of chapter.onChapterEnter) {
      referenced.add(change.layerId);
    }
    for (const change of chapter.onChapterExit) {
      referenced.add(change.layerId);
    }
  }

  // A layer's starting opacity must match what the in-app presenter shows on the
  // first chapter, which applies chapter 0's onChapterEnter on top of the live
  // (naturally visible) layers via enterChapter(0). So seed each layer from
  // chapter 0's opacity if it sets one, and otherwise leave it at its natural
  // opacity. The previous heuristic started *any* layer a later chapter fades in
  // at opacity 0, which hid a basemap raster that a chapter fades to 1 until the
  // reader scrolled to it, leaving the map blank on load (#950).
  const chapterZeroOpacity = new Map<string, number>();
  for (const change of storymap.chapters[0].onChapterEnter) {
    chapterZeroOpacity.set(change.layerId, change.opacity);
  }

  const inlineLayers: InlineLayerExport[] = [];
  for (const layer of layers) {
    const isReferenced = referenced.has(layer.id);
    if (!isReferenced && !layer.visible) continue;
    // Inline GeoJSON layers and raster tile layers (the latter covers basemaps
    // added through the Basemaps plugin, which are raster layers rather than a
    // style URL, #936). Layers iterate in store order; the store array is
    // bottom-to-top, and `map.addLayer` appends each layer above the previous,
    // so the export reproduces whatever stacking the user set in the app
    // (the Basemaps plugin inserts basemaps at the bottom, so they end up under
    // the overlays here too).
    const built = buildInlineLayer(layer);
    if (!built) continue;
    inlineLayers.push({
      id: layer.id,
      source: built.source,
      layerSpec: built.layerSpec,
      // Hidden layers export fully transparent so the export matches what
      // GeoLibre renders (the opacity slider value alone ignores visibility).
      layerOpacity: layer.visible ? layer.opacity : 0,
      // Absolute opacity chapter 0 sets for this layer, if any. When present it
      // overrides the natural opacity below so the first frame matches the app.
      chapterZeroOpacity: chapterZeroOpacity.get(layer.id),
    });
  }

  // Opacity effects can only target layers that actually exist in the export;
  // others would make the exported page throw on `map.getLayer(...).type`. The
  // template runtime reads `layer.layer` for the MapLibre id, so map our
  // `layerId` field onto that shape as well.
  const inlinedIds = new Set(inlineLayers.map((entry) => entry.id));
  const keepChanges = (changes: StoryMap["chapters"][number]["onChapterEnter"]) =>
    changes
      .filter((change) => inlinedIds.has(change.layerId))
      .map((change) => ({
        layer: change.layerId,
        opacity: change.opacity,
        ...(change.duration !== undefined ? { duration: change.duration } : {}),
      }));

  const config = {
    // Fall back to a blank style when the project carries no basemap style URL
    // (e.g. the basemap is a Basemaps-plugin raster layer, inlined above), so
    // MapLibre renders instead of showing a blank page (#936).
    style: basemapStyleUrl || BLANK_EXPORT_STYLE,
    projection,
    showMarkers: storymap.showMarkers,
    markerColor: storymap.markerColor,
    inset: storymap.inset,
    insetPosition: storymap.insetPosition,
    insetStyle: STORY_INSET_STYLE_URL,
    insetZoom: 1,
    theme: storymap.theme,
    auto: false,
    // Start the chapter list collapsed and reveal chapters one at a time (#995).
    hideChapterNav: storymap.hideChapterNav,
    // Optional intro/outro slides shown before/after the chapters (#998).
    startSlide: storymap.startSlide,
    endSlide: storymap.endSlide,
    globalView: STORY_GLOBAL_VIEW,
    startStepId: STORY_START_STEP_ID,
    endStepId: STORY_END_STEP_ID,
    navToggleLabel,
    title: storymap.title,
    subtitle: storymap.subtitle,
    byline: storymap.byline,
    // Description and footer are written into the exported page via innerHTML,
    // so sanitize them here just like the in-app presenter does.
    footer: sanitizeStoryHtml(storymap.footer),
    chapters: storymap.chapters.map((chapter) => ({
      id: chapter.id,
      alignment: chapter.alignment,
      hidden: chapter.hidden,
      title: chapter.title,
      image: chapter.image ?? "",
      description: sanitizeStoryHtml(chapter.description),
      location: {
        center: chapter.location.center,
        zoom: chapter.location.zoom,
        pitch: chapter.location.pitch,
        bearing: chapter.location.bearing,
      },
      mapAnimation: chapter.mapAnimation,
      rotateAnimation: chapter.rotateAnimation,
      callback: "",
      onChapterEnter: keepChanges(chapter.onChapterEnter),
      onChapterExit: keepChanges(chapter.onChapterExit),
    })),
  };

  const inlineLayerScript = inlineLayers
    .map((entry) => {
      const sourceId = `${entry.id}-source`;
      const paint = { ...(entry.layerSpec.paint as Record<string, unknown>) };
      // Seed every opacity paint property the layer type fades. When chapter 0
      // assigns this layer an opacity, start there (matching the in-app first
      // frame, #950); otherwise use the style's per-property opacity scaled by
      // the layer opacity so the export matches what GeoLibre renders. A chapter
      // 0 opacity wins outright, including over a hidden layer's 0, exactly as
      // the in-app presenter's setLayerOpacity overwrites the live value. Circles
      // carry both fill and stroke opacity so a faded point hides fully (#934).
      for (const opacityProp of opacityProperties(entry.layerSpec.type as string)) {
        const styleOpacity =
          typeof paint[opacityProp] === "number" ? (paint[opacityProp] as number) : 1;
        paint[opacityProp] =
          entry.chapterZeroOpacity !== undefined
            ? entry.chapterZeroOpacity
            : styleOpacity * entry.layerOpacity;
      }
      const spec = {
        ...entry.layerSpec,
        id: entry.id,
        source: sourceId,
        paint,
      };
      return `    map.addSource(${jsonForScript(sourceId)}, ${jsonForScript(entry.source)});
    map.addLayer(${jsonForScript(spec)});`;
    })
    .join("\n");

  return renderTemplate(config, inlineLayerScript);
}

/**
 * Serialize a value to JSON for embedding inside an inline `<script>` block.
 *
 * Escapes `</` and `<!--` so a string containing `</script>` or an HTML comment
 * opener cannot terminate the script element early or start a comment, which
 * would let crafted project content inject markup into the exported page.
 */
function jsonForScript(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space).replace(/<\//g, "<\\/").replace(/<!--/g, "<\\!--");
}

function opacityProperties(type: string): string[] {
  switch (type) {
    case "fill":
      return ["fill-opacity"];
    case "line":
      return ["line-opacity"];
    case "circle":
      return ["circle-opacity", "circle-stroke-opacity"];
    case "fill-extrusion":
      return ["fill-extrusion-opacity"];
    case "raster":
      return ["raster-opacity"];
    default:
      return [];
  }
}

/**
 * Build the MapLibre source and layer spec for a layer the export inlines.
 *
 * Handles in-memory GeoJSON layers and raster tile layers (XYZ basemaps and
 * services). Returns `null` for layer types the export cannot reproduce
 * stand-alone (e.g. PMTiles or MBTiles that need GeoLibre's own protocols).
 */
function buildInlineLayer(
  layer: GeoLibreLayer,
): { source: Record<string, unknown>; layerSpec: Record<string, unknown> } | null {
  if (layer.type === "geojson" && layer.geojson) {
    const layerSpec = buildLayerSpec(layer);
    if (!layerSpec) return null;
    return {
      source: { type: "geojson", data: layer.geojson },
      layerSpec,
    };
  }
  const rasterSource = buildRasterTileSource(layer);
  if (rasterSource) {
    return {
      source: rasterSource,
      // Mirror the live app's rasterPaint so raster color adjustments
      // (brightness/saturation/contrast/hue) survive the export. raster-opacity
      // is the seed the opacity loop later scales by the layer opacity.
      layerSpec: {
        type: "raster",
        paint: {
          "raster-opacity": 1,
          "raster-brightness-min": styleValue(layer.style, "rasterBrightnessMin"),
          "raster-brightness-max": styleValue(layer.style, "rasterBrightnessMax"),
          "raster-saturation": styleValue(layer.style, "rasterSaturation"),
          "raster-contrast": styleValue(layer.style, "rasterContrast"),
          "raster-hue-rotate": styleValue(layer.style, "rasterHueRotate"),
        },
      },
    };
  }
  return null;
}

/**
 * Build a MapLibre raster tile source from a raster/XYZ/WMS/WMTS layer, or
 * `null` when the layer carries no tile URL template or TileJSON URL. Mirrors
 * the live app's external raster tile sync so basemaps and tile services
 * render in the export. A TileJSON `url` covers service-backed rasters such as
 * Planetary Computer scenes, whose tiler resolves and signs the actual tile
 * URLs server-side at load time, so for such resolver-backed services the
 * export embeds a stable endpoint instead of an expiring token (#1272). A
 * provider whose url or tile template is itself pre-signed still expires with
 * its credential — the export can only embed what the source exposes.
 */
function buildRasterTileSource(layer: GeoLibreLayer): Record<string, unknown> | null {
  if (
    layer.type !== "raster" &&
    layer.type !== "xyz" &&
    layer.type !== "wms" &&
    layer.type !== "wmts"
  ) {
    return null;
  }
  // Only http(s) tile templates and TileJSON URLs can load in a standalone
  // page; app-internal protocols (blob:, pmtiles:, geolibre:, …) have no
  // handler there.
  const isHttpUrl = (value: unknown): value is string =>
    typeof value === "string" && /^https?:\/\//i.test(value);
  const tiles = Array.isArray(layer.source.tiles) ? layer.source.tiles.filter(isHttpUrl) : [];
  // The TileJSON `url` fallback is scoped to plain raster layers: wms/wmts
  // records keep the raw service endpoint (not a TileJSON) in `url` — their
  // loadable template lives in `tiles` — so embedding it would produce a
  // source MapLibre cannot parse instead of just omitting the layer.
  const url = layer.type === "raster" && isHttpUrl(layer.source.url) ? layer.source.url : null;
  if (tiles.length === 0 && !url) return null;
  const source: Record<string, unknown> = {
    type: "raster",
    ...(tiles.length > 0 ? { tiles } : { url }),
    tileSize: typeof layer.source.tileSize === "number" ? layer.source.tileSize : 256,
  };
  if (typeof layer.source.minzoom === "number") {
    source.minzoom = layer.source.minzoom;
  }
  if (typeof layer.source.maxzoom === "number") {
    source.maxzoom = layer.source.maxzoom;
  }
  if (layer.source.scheme === "tms") source.scheme = "tms";
  if (typeof layer.source.attribution === "string") {
    source.attribution = layer.source.attribution;
  }
  // Carry the source's coverage extent so the export, like the live map, stops
  // requesting tiles outside a bounded tile service.
  if (
    Array.isArray(layer.source.bounds) &&
    layer.source.bounds.length === 4 &&
    layer.source.bounds.every(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    )
  ) {
    source.bounds = layer.source.bounds;
  }
  return source;
}

/** Pick the dominant (most common) geometry kind for the MapLibre layer type. */
function geometryKind(geojson: FeatureCollection): "polygon" | "line" | "point" | null {
  const counts = { polygon: 0, line: 0, point: 0 };
  for (const feature of geojson.features) {
    const kind = classifyGeometry(feature.geometry);
    if (kind) counts[kind]++;
  }
  let best: "polygon" | "line" | "point" | null = null;
  for (const kind of ["polygon", "line", "point"] as const) {
    if (counts[kind] > 0 && (best === null || counts[kind] > counts[best])) {
      best = kind;
    }
  }
  return best;
}

function classifyGeometry(geometry: Geometry | null): "polygon" | "line" | "point" | null {
  if (!geometry) return null;
  switch (geometry.type) {
    case "Polygon":
    case "MultiPolygon":
      return "polygon";
    case "LineString":
    case "MultiLineString":
      return "line";
    case "Point":
    case "MultiPoint":
      return "point";
    case "GeometryCollection":
      for (const sub of geometry.geometries) {
        const kind = classifyGeometry(sub);
        if (kind) return kind;
      }
      return null;
    default:
      return null;
  }
}

/** Convert a GeoLibre GeoJSON layer to a minimal MapLibre layer spec. */
function buildLayerSpec(layer: GeoLibreLayer): Record<string, unknown> | null {
  if (!layer.geojson) return null;
  const kind = geometryKind(layer.geojson);
  if (!kind) return null;

  if (kind === "polygon") {
    // Extruded polygons export as a 3D fill-extrusion (mirroring the in-app
    // render) so the story keeps its extruded look instead of flattening to a
    // 2D fill (#917). The opacity is seeded here and scaled by the layer
    // opacity later, just like the flat-fill path.
    if (layer.style.extrusionEnabled) {
      return {
        type: "fill-extrusion",
        paint: {
          "fill-extrusion-color": extrusionColorValue(layer.style),
          "fill-extrusion-opacity": styleValue(layer.style, "extrusionOpacity"),
          "fill-extrusion-height": extrusionHeightValue(layer.style),
          "fill-extrusion-base": styleValue(layer.style, "extrusionBase"),
          "fill-extrusion-vertical-gradient": true,
        },
      };
    }
    return {
      type: "fill",
      paint: {
        "fill-color": styleValue(layer.style, "fillColor"),
        "fill-opacity": styleValue(layer.style, "fillOpacity"),
        "fill-outline-color": styleValue(layer.style, "strokeColor"),
      },
    };
  }
  if (kind === "line") {
    return {
      type: "line",
      paint: {
        "line-color": styleValue(layer.style, "strokeColor"),
        "line-width": styleValue(layer.style, "strokeWidth"),
        "line-opacity": 1,
      },
    };
  }
  return {
    type: "circle",
    paint: {
      "circle-color": styleValue(layer.style, "fillColor"),
      "circle-radius": styleValue(layer.style, "circleRadius"),
      "circle-stroke-color": styleValue(layer.style, "strokeColor"),
      "circle-stroke-width": styleValue(layer.style, "strokeWidth"),
      // In-app circle-opacity is fillOpacity * layerOpacity; seed fillOpacity
      // here so the later layerOpacity scaling matches.
      "circle-opacity": styleValue(layer.style, "fillOpacity"),
    },
  };
}

function renderTemplate(config: Record<string, unknown>, inlineLayerScript: string): string {
  const configJson = jsonForScript(config, 4);
  return `<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset='utf-8' />
    <title>${escapeHtml(String(config.title || "Story Map"))}</title>
    <meta name='viewport' content='initial-scale=1,maximum-scale=1,user-scalable=no' />
    <!-- SRI hashes are pinned to the versions above; update both together. -->
    <script src='https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js' integrity='sha384-5+cfbwT0iiub6VsQAdn6yz16nr6sDiQoHx6tm4O8OVYXHYOxcffFmCJBL0dgdvGp' crossorigin='anonymous'></script>
    <link href='https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css' rel='stylesheet' integrity='sha384-uTttxo/aOKbdE5RlD/SPzSDoDmNvGlUYPjONi2MN/b7c9HPSvW07OIuyP7uL6jxK' crossorigin='anonymous' />
    <script src="https://unpkg.com/scrollama@3.2.0/build/scrollama.js" integrity="sha384-cQr5Cx9W8UDNyE09swPH4QMork1pq5sHUzY32DbxJ/WpWFSpr2MG8FGs/3pMjp2S" crossorigin="anonymous"></script>
    <style>
        body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        a, a:hover, a:visited { color: #0071bc; }
        #map { top: 0; height: 100vh; width: 100vw; position: fixed; }
        #header { margin: auto; width: 100%; position: relative; z-index: 5; }
        #header h1, #header h2, #header p { margin: 0; padding: 2vh 2vw; text-align: center; }
        #footer { width: 100%; min-height: 5vh; padding: 2vh 0; text-align: center; line-height: 25px; font-size: 13px; position: relative; z-index: 5; }
        #features { padding-top: 10vh; padding-bottom: 10vh; }
        .hidden { visibility: hidden; }
        .centered { width: 50vw; margin: 0 auto; }
        .lefty { width: 33vw; margin-left: 5vw; }
        .righty { width: 33vw; margin-left: 62vw; }
        .fully { width: 100%; margin: auto; }
        .light { color: #444; background-color: #fafafa; }
        .dark { color: #fafafa; background-color: #444; }
        .step { padding-bottom: 50vh; opacity: 0.25; transition: opacity 0.3s; }
        .step.active { opacity: 0.95; }
        /* Start/closing slides are empty full-height scroll targets (#998). */
        .sm-slide-step { min-height: 90vh; padding-bottom: 0; }
        /* Solid cover painted over the map for a blank/black slide; below the
           nav, and pointer-events:none so the page still scrolls. */
        #slide-cover { position: fixed; inset: 0; z-index: 15; display: none; pointer-events: none; }
        .sm-card { position: relative; display: flex; flex-direction: column; max-height: 70vh; line-height: 22px; font-size: 14px; border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,0.25); overflow: hidden; }
        .sm-bar { display: flex; align-items: center; gap: 6px; padding: 7px 10px; cursor: move; user-select: none; touch-action: none; font-weight: 600; font-size: 13px; border-bottom: 1px solid rgba(127,127,127,0.25); }
        .sm-grip { opacity: 0.5; flex-shrink: 0; }
        .sm-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .sm-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px 18px; }
        .sm-body p { margin: 0; }
        .sm-body img { width: 100%; max-height: 38vh; object-fit: cover; border-radius: 2px; }
        .sm-resize { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize; touch-action: none; }
        .sm-resize::after { content: ''; position: absolute; right: 4px; bottom: 4px; width: 7px; height: 7px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; opacity: 0.5; }
        #nav { position: fixed; left: 12px; top: 52px; max-height: calc(100vh - 64px); width: 220px; overflow-y: auto; z-index: 20; border-radius: 6px; padding: 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.3); font-size: 13px; }
        #nav.dark { background: rgba(40,40,40,0.85); color: #fafafa; }
        #nav.light { background: rgba(250,250,250,0.92); color: #444; }
        #nav.hidden-nav { display: none; }
        /* Toggle button for the chapter list (#995). */
        #nav-toggle { position: fixed; left: 12px; top: 12px; z-index: 21; width: 32px; height: 32px; border: none; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px; box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
        #nav-toggle.dark { background: rgba(40,40,40,0.85); color: #fafafa; }
        #nav-toggle.light { background: rgba(250,250,250,0.92); color: #444; }
        .nav-item { display: flex; gap: 8px; align-items: center; padding: 7px 9px; border-radius: 4px; cursor: pointer; }
        .nav-item:hover { background: rgba(127,127,127,0.18); }
        .nav-item.active { background: rgba(63,177,206,0.22); font-weight: 600; }
        .nav-num { width: 20px; height: 20px; border-radius: 50%; background: rgba(127,127,127,0.3); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; flex-shrink: 0; }
        .nav-item.active .nav-num { background: #3fb1ce; color: #fff; }
        .nav-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        /* Keep the nav toggle reachable on small screens so the chapter list
           stays discoverable; only cap the pane width to the viewport. */
        @media (max-width: 750px) { .centered, .lefty, .righty, .fully { width: 90vw; margin: 0 auto; } #nav { width: auto; max-width: calc(100vw - 24px); } }
        .maplibregl-canvas-container.maplibregl-touch-zoom-rotate.maplibregl-touch-drag-pan,
        .maplibregl-canvas-container.maplibregl-touch-zoom-rotate.maplibregl-touch-drag-pan .maplibregl-canvas { touch-action: unset; }
        #inset-map { position: fixed; width: 180px; height: 180px; border: 2px solid rgba(255, 255, 255, 0.8); border-radius: 4px; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3); z-index: 10; }
        #inset-map.top-left { top: 10px; left: 10px; }
        #inset-map.top-right { top: 10px; right: 10px; }
        #inset-map.bottom-left { bottom: 30px; left: 10px; }
        #inset-map.bottom-right { bottom: 30px; right: 10px; }
        .inset-marker { width: 12px; height: 12px; background-color: #ff6b6b; border: 2px solid white; border-radius: 50%; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3); }
    </style>
</head>

<body>
    <div id="map"></div>
    <div id="story"></div>

    <script>
        var config = ${configJson};
    </script>
    <script>
        var layerTypes = {
            'fill': ['fill-opacity'],
            'line': ['line-opacity'],
            'circle': ['circle-opacity', 'circle-stroke-opacity'],
            'symbol': ['icon-opacity', 'text-opacity'],
            'raster': ['raster-opacity'],
            'fill-extrusion': ['fill-extrusion-opacity'],
            'heatmap': ['heatmap-opacity'],
            'hillshade': ['hillshade-exaggeration']
        };
        var alignments = { 'left': 'lefty', 'center': 'centered', 'right': 'righty', 'full': 'fully' };

        function getLayerPaintType(layer) { var sl = map.getLayer(layer); return sl ? layerTypes[sl.type] : null; }
        function setLayerOpacity(layer) {
            if (!map.getLayer(layer.layer)) return;
            var paintProps = getLayerPaintType(layer.layer);
            if (!paintProps) return;
            paintProps.forEach(function (prop) {
                if (layer.duration) {
                    map.setPaintProperty(layer.layer, prop + '-transition', { duration: layer.duration });
                }
                map.setPaintProperty(layer.layer, prop, layer.opacity);
            });
        }

        var story = document.getElementById('story');
        var features = document.createElement('div');
        features.setAttribute('id', 'features');
        var header = document.createElement('div');

        if (config.title) { var t = document.createElement('h1'); t.innerText = config.title; header.appendChild(t); }
        if (config.subtitle) { var s = document.createElement('h2'); s.innerText = config.subtitle; header.appendChild(s); }
        if (config.byline) { var b = document.createElement('p'); b.innerText = config.byline; header.appendChild(b); }
        if (header.children.length > 0) { header.classList.add(config.theme); header.setAttribute('id', 'header'); story.appendChild(header); }

        function makeDraggable(handle, card) {
            var dx = 0, dy = 0;
            handle.addEventListener('pointerdown', function (e) {
                e.preventDefault();
                var sx = e.clientX, sy = e.clientY, bx = dx, by = dy;
                function move(ev) { dx = bx + (ev.clientX - sx); dy = by + (ev.clientY - sy); card.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'; }
                function up() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); }
                window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
            });
            handle.addEventListener('dblclick', function () { dx = 0; dy = 0; card.style.transform = ''; });
        }
        function makeResizable(handle, card) {
            handle.addEventListener('pointerdown', function (e) {
                e.preventDefault(); e.stopPropagation();
                var sx = e.clientX, sy = e.clientY, r = card.getBoundingClientRect(), bw = r.width, bh = r.height;
                function move(ev) { card.style.width = Math.max(200, bw + (ev.clientX - sx)) + 'px'; card.style.height = Math.max(120, bh + (ev.clientY - sy)) + 'px'; }
                function up() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); }
                window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
            });
        }

        // Optional intro/outro slides are empty full-height scroll targets;
        // their treatment (cover or camera) is applied on enter (#998).
        function makeSlideStep(id) {
            var s = document.createElement('div');
            s.className = 'step sm-slide-step';
            s.setAttribute('id', id);
            return s;
        }
        if (config.startSlide && config.startSlide !== 'none') features.appendChild(makeSlideStep(config.startStepId));

        config.chapters.forEach(function (record, idx) {
            var container = document.createElement('div');
            container.setAttribute('id', record.id);
            container.classList.add('step');
            container.classList.add(alignments[record.alignment] || 'centered');
            // Don't pre-activate chapter 1 when a start slide opens the story, so
            // its active state isn't shown during the intro slide (#998 review).
            if (idx === 0 && !(config.startSlide && config.startSlide !== 'none')) container.classList.add('active');
            if (record.hidden) container.classList.add('hidden');

            var card = document.createElement('div');
            card.className = 'sm-card ' + config.theme;

            var bar = document.createElement('div');
            bar.className = 'sm-bar';
            var grip = document.createElement('span'); grip.className = 'sm-grip'; grip.textContent = '☰';
            var barTitle = document.createElement('span'); barTitle.className = 'sm-title'; barTitle.innerText = record.title || ('Chapter ' + (idx + 1));
            bar.appendChild(grip); bar.appendChild(barTitle);
            makeDraggable(bar, card);
            card.appendChild(bar);

            var body = document.createElement('div');
            body.className = 'sm-body';
            if (record.image) { var img = new Image(); img.src = record.image; body.appendChild(img); }
            if (record.description) { var p = document.createElement('p'); p.innerHTML = record.description; body.appendChild(p); }
            card.appendChild(body);

            var rz = document.createElement('div'); rz.className = 'sm-resize';
            makeResizable(rz, card);
            card.appendChild(rz);

            container.appendChild(card);
            features.appendChild(container);
        });
        if (config.endSlide && config.endSlide !== 'none') features.appendChild(makeSlideStep(config.endStepId));
        story.appendChild(features);

        // Navigation pane: list chapters and jump to one on click.
        var nav = document.createElement('div');
        nav.id = 'nav';
        nav.className = config.theme;
        config.chapters.forEach(function (record, idx) {
            var item = document.createElement('div');
            item.className = 'nav-item' + ((idx === 0 && !(config.startSlide && config.startSlide !== 'none')) ? ' active' : '');
            item.setAttribute('data-id', record.id);
            var num = document.createElement('span'); num.className = 'nav-num'; num.innerText = (idx + 1);
            var t = document.createElement('span'); t.className = 'nav-title'; t.innerText = record.title || ('Chapter ' + (idx + 1));
            item.appendChild(num); item.appendChild(t);
            item.addEventListener('click', function () {
                var c = document.getElementById(record.id);
                var card = c && c.querySelector('.sm-card');
                (card || c).scrollIntoView({ block: 'center' });
            });
            nav.appendChild(item);
        });
        document.body.appendChild(nav);
        var navItems = nav.querySelectorAll('.nav-item');

        // Toggle button so the chapter list can be opened/closed; it starts
        // collapsed for a "discoverable chapters" story (#995).
        var navToggle = document.createElement('button');
        navToggle.id = 'nav-toggle';
        navToggle.className = config.theme;
        navToggle.type = 'button';
        navToggle.title = config.navToggleLabel;
        navToggle.setAttribute('aria-label', config.navToggleLabel);
        // aria-pressed mirrors the in-app presenter so assistive tech announces
        // whether the chapter list is open (#995). It is true when the nav shows.
        navToggle.setAttribute('aria-pressed', config.hideChapterNav ? 'false' : 'true');
        navToggle.textContent = '☰';
        navToggle.addEventListener('click', function () {
            var nowHidden = nav.classList.toggle('hidden-nav');
            navToggle.setAttribute('aria-pressed', nowHidden ? 'false' : 'true');
        });
        document.body.appendChild(navToggle);
        if (config.hideChapterNav) nav.classList.add('hidden-nav');

        // Solid cover for a blank/black start or closing slide (#998).
        var cover = document.createElement('div');
        cover.id = 'slide-cover';
        document.body.appendChild(cover);
        function slideBg(mode) {
            if (mode === 'black') return '#000000';
            if (mode === 'blank') return config.theme === 'light' ? '#fafafa' : '#444444';
            return null;
        }

        var footer = document.createElement('div');
        if (config.footer) { var f = document.createElement('p'); f.innerHTML = config.footer; footer.appendChild(f); }
        if (footer.children.length > 0) { footer.classList.add(config.theme); footer.setAttribute('id', 'footer'); story.appendChild(footer); }

        // Apply the start slide's initial state during DOM construction (before
        // map load) so a slow style/tile load can't flash the story header/footer
        // or an uncovered map on a supposedly text-free start slide (#998 review).
        if (config.startSlide && config.startSlide !== 'none') {
            var startHeaderEl = document.getElementById('header');
            if (startHeaderEl) startHeaderEl.classList.add('hidden');
            var startFooterEl = document.getElementById('footer');
            if (startFooterEl) startFooterEl.classList.add('hidden');
            var startBg = slideBg(config.startSlide);
            if (startBg) { cover.style.background = startBg; cover.style.display = 'block'; }
        }

        // Shape right-to-left scripts (Arabic, Hebrew, Persian, …) correctly so
        // basemap labels are not rendered reversed. Lazy-loaded, so it only
        // downloads when an RTL label is actually encountered. The URL is loaded
        // by a Web Worker via importScripts(), which (unlike a <script> tag)
        // cannot carry an SRI integrity hash; we pin the exact version instead,
        // matching the CDN trust already extended to maplibre-gl/scrollama above.
        if (maplibregl.getRTLTextPluginStatus?.() === 'unavailable') {
            // MapLibre GL v4+ signature is (url, lazy?) returning a Promise; the
            // lazy flag is the SECOND arg, and the Promise must be caught.
            maplibregl.setRTLTextPlugin('https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.4.0/dist/mapbox-gl-rtl-text.js', true).catch(function (e) { console.error('[GeoLibre] RTL plugin failed', e); });
        }

        // For a global start slide, open the map (and inset/markers) at the
        // global view rather than chapter 0, so a slow style/tile load doesn't
        // flash chapter 0's view before the load handler flies out (#998 review).
        var openLocation = config.startSlide === 'global' ? config.globalView : config.chapters[0].location;

        var map = new maplibregl.Map({
            container: 'map',
            style: config.style,
            center: openLocation.center,
            zoom: openLocation.zoom,
            bearing: openLocation.bearing,
            pitch: openLocation.pitch,
            interactive: false
        });

        var insetMap = null, insetMarker = null;
        if (config.inset) {
            var insetContainer = document.createElement('div');
            insetContainer.id = 'inset-map';
            insetContainer.classList.add(config.insetPosition || 'bottom-left');
            document.body.appendChild(insetContainer);
            insetMap = new maplibregl.Map({ container: 'inset-map', style: config.insetStyle, center: openLocation.center, zoom: config.insetZoom || 1, interactive: false, attributionControl: false });
            var markerEl = document.createElement('div');
            markerEl.className = 'inset-marker';
            insetMarker = new maplibregl.Marker({ element: markerEl }).setLngLat(openLocation.center).addTo(insetMap);
            // The global overview shows no marker; hide it immediately.
            if (config.startSlide === 'global') insetMarker.getElement().style.visibility = 'hidden';
        }

        var marker = null;
        if (config.showMarkers) {
            marker = new maplibregl.Marker({ color: config.markerColor });
            marker.setLngLat(openLocation.center).addTo(map);
            if (config.startSlide === 'global') marker.getElement().style.visibility = 'hidden';
        }

        var scroller = scrollama();
        var cameraToken = 0;
        // Set once the start slide is initialized synchronously on load, so the
        // first (redundant) Scrollama enter for it is skipped (#998 review).
        var startSlideInitialized = false;

        map.once('load', function () {
            // Match the in-app projection (globe by default) so the exported
            // story does not silently fall back to 2D Mercator (#917).
            try {
                map.setProjection({ type: config.projection || 'globe' });
            } catch (e) {
                console.error('[GeoLibre] projection failed', e);
            }
${inlineLayerScript}

            // Drive a start/closing slide (#998): blank/black paint a solid
            // cover over the map; global zooms out; "adjacent" previews the
            // first chapter (start) or holds the last chapter (end) with the
            // text hidden.
            // Hide/show the map (and inset) markers. The "global" overview slide
            // is a clean world view, so its marker is hidden; chapters and the
            // adjacent preview keep theirs.
            function setMarkersVisible(visible) {
                var value = visible ? '' : 'hidden';
                if (marker) marker.getElement().style.visibility = value;
                if (insetMarker) insetMarker.getElement().style.visibility = value;
            }

            // Hide/show the story title/byline/footer chrome. Slides are
            // documented as text-free, so the persistent header and footer hide
            // while one is active, matching the in-app presenter (the blank/black
            // cover already hides them; this also clears them for global/adjacent).
            function setChromeHidden(hidden) {
                var headerEl = document.getElementById('header');
                var footerEl = document.getElementById('footer');
                if (headerEl) headerEl.classList.toggle('hidden', hidden);
                if (footerEl) footerEl.classList.toggle('hidden', hidden);
            }

            function enterSlide(mode, isStart) {
                navItems.forEach(function (it) { it.classList.remove('active'); });
                map.stop();
                ++cameraToken;
                setChromeHidden(true);
                var bg = slideBg(mode);
                if (bg) { cover.style.background = bg; cover.style.display = 'block'; return; }
                cover.style.display = 'none';
                // The export never ships with zero chapters (buildStoryMapHtml
                // throws first), but fall back to the global view defensively so
                // an "adjacent" slide can never read an undefined location.
                var adjacent = isStart
                    ? config.chapters[0]
                    : config.chapters[config.chapters.length - 1];
                var loc = mode === 'global'
                    ? config.globalView
                    : ((adjacent && adjacent.location) || config.globalView);
                map.flyTo(loc);
                // Global overview shows no marker; adjacent preview keeps it.
                if (mode === 'global') {
                    setMarkersVisible(false);
                } else {
                    setMarkersVisible(true);
                    if (config.showMarkers && marker) marker.setLngLat(loc.center);
                    if (insetMap && insetMarker) { insetMap.setCenter(loc.center); insetMarker.setLngLat(loc.center); }
                }
            }

            scroller.setup({ step: '.step', offset: 0.5 })
                .onStepEnter(function (response) {
                    var id = response.element.id;
                    response.element.classList.add('active');
                    if (id === config.startStepId || id === config.endStepId) {
                        // Skip the redundant first enter for the start slide that
                        // was already initialized synchronously on load, so
                        // global/adjacent modes don't fly the camera twice.
                        if (id === config.startStepId && startSlideInitialized) {
                            startSlideInitialized = false;
                            return;
                        }
                        enterSlide(id === config.startStepId ? config.startSlide : config.endSlide, id === config.startStepId);
                        return;
                    }
                    cover.style.display = 'none';
                    setChromeHidden(false);
                    var idx = config.chapters.findIndex(function (c) { return c.id === id; });
                    var chapter = config.chapters[idx];
                    if (!chapter) return;
                    navItems.forEach(function (it) { it.classList.toggle('active', it.getAttribute('data-id') === id); });
                    // Cancel any in-progress move (e.g. a prior chapter's rotation)
                    // and bump the token so its pending moveend handler is ignored.
                    map.stop();
                    var token = ++cameraToken;
                    map[chapter.mapAnimation || 'flyTo'](chapter.location);
                    // Re-show the marker in case a preceding global slide hid it.
                    setMarkersVisible(true);
                    if (config.showMarkers && marker) marker.setLngLat(chapter.location.center);
                    if (insetMap && insetMarker) { insetMap.setCenter(chapter.location.center); insetMarker.setLngLat(chapter.location.center); }
                    if (chapter.onChapterEnter.length > 0) chapter.onChapterEnter.forEach(setLayerOpacity);
                    if (chapter.rotateAnimation) {
                        map.once('moveend', function () {
                            if (token !== cameraToken) return;
                            var bearing = map.getBearing();
                            map.rotateTo(bearing + 180, { duration: 30000, easing: function (t) { return t; } });
                        });
                    }
                })
                .onStepExit(function (response) {
                    response.element.classList.remove('active');
                    var chapter = config.chapters.find(function (c) { return c.id === response.element.id; });
                    if (!chapter) return;
                    if (chapter.onChapterExit.length > 0) chapter.onChapterExit.forEach(setLayerOpacity);
                });

            // Set the start slide's camera deterministically on load, mirroring
            // the in-app presenter's first step (#998). This runs synchronously
            // before Scrollama's first (async) onStepEnter fires for the in-view
            // start slide, so the flag below skips that redundant second enter
            // (which would otherwise fly the camera twice for global/adjacent).
            if (config.startSlide && config.startSlide !== 'none') {
                enterSlide(config.startSlide, true);
                startSlideInitialized = true;
            }
        });

        window.addEventListener('resize', scroller.resize);
    </script>
</body>

</html>
`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
