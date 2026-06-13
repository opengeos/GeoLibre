import type { FeatureCollection, Geometry } from "geojson";
import {
  styleValue,
  type GeoLibreLayer,
  type StoryMap,
} from "@geolibre/core";
import { sanitizeStoryHtml } from "./sanitize-html";

export interface StoryMapExportOptions {
  storymap: StoryMap;
  /** MapLibre style URL used as the story basemap. */
  basemapStyleUrl: string;
  /** Project layers; only in-memory GeoJSON layers are inlined into the export. */
  layers: GeoLibreLayer[];
}

interface InlineLayerExport {
  id: string;
  geojson: FeatureCollection;
  layerSpec: Record<string, unknown>;
  /** Opacity paint property to drive with story chapter transitions. */
  initialOpacity: number;
}

const INSET_STYLE_URL =
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

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
  const { storymap, basemapStyleUrl, layers } = options;

  // The template reads chapters[0] for the initial camera, so an empty story
  // cannot produce a working page. Callers gate this behind a chapter count,
  // but fail loudly if that ever slips.
  if (storymap.chapters.length === 0) {
    throw new Error("Cannot export a story map with no chapters.");
  }

  // Only inline layers that are actually referenced by a chapter transition or
  // that are visible GeoJSON layers, so the export stays focused on the story.
  // `referenced` (enter ∪ exit) drives which layers to inline; only layers a
  // chapter fades *in* should start hidden, so those are tracked separately.
  const referenced = new Set<string>();
  const referencedOnEnter = new Set<string>();
  for (const chapter of storymap.chapters) {
    for (const change of chapter.onChapterEnter) {
      referenced.add(change.layerId);
      referencedOnEnter.add(change.layerId);
    }
    for (const change of chapter.onChapterExit) {
      referenced.add(change.layerId);
    }
  }

  const inlineLayers: InlineLayerExport[] = [];
  for (const layer of layers) {
    if (layer.type !== "geojson" || !layer.geojson) continue;
    const isReferenced = referenced.has(layer.id);
    if (!isReferenced && !layer.visible) continue;
    const layerSpec = buildLayerSpec(layer);
    if (!layerSpec) continue;
    inlineLayers.push({
      id: layer.id,
      geojson: layer.geojson,
      layerSpec,
      // Layers a chapter fades in start hidden; exit-only layers keep their
      // natural opacity so they are visible until faded out.
      initialOpacity: referencedOnEnter.has(layer.id) ? 0 : layer.opacity,
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
    style: basemapStyleUrl,
    showMarkers: storymap.showMarkers,
    markerColor: storymap.markerColor,
    inset: storymap.inset,
    insetPosition: storymap.insetPosition,
    insetStyle: INSET_STYLE_URL,
    insetZoom: 1,
    theme: storymap.theme,
    auto: false,
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
      // Override the opacity paint property with the story's initial value.
      const opacityProp = opacityProperty(entry.layerSpec.type as string);
      if (opacityProp) paint[opacityProp] = entry.initialOpacity;
      const spec = {
        ...entry.layerSpec,
        id: entry.id,
        source: sourceId,
        paint,
      };
      return `    map.addSource(${jsonForScript(sourceId)}, { type: 'geojson', data: ${jsonForScript(entry.geojson)} });
    map.addLayer(${jsonForScript(spec)});`;
    })
    .join("\n");

  return renderTemplate(config, inlineLayerScript);
}

/**
 * Serialize a value to JSON for embedding inside an inline `<script>` block.
 *
 * Escapes `</` so a string containing `</script>` (or any other closing tag)
 * cannot terminate the script element early, which would let crafted project
 * content inject markup into the exported page.
 */
function jsonForScript(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space).replace(/<\//g, "<\\/");
}

function opacityProperty(type: string): string | null {
  switch (type) {
    case "fill":
      return "fill-opacity";
    case "line":
      return "line-opacity";
    case "circle":
      return "circle-opacity";
    case "fill-extrusion":
      return "fill-extrusion-opacity";
    default:
      return null;
  }
}

/** Pick a dominant geometry kind for choosing a MapLibre layer type. */
function geometryKind(
  geojson: FeatureCollection,
): "polygon" | "line" | "point" | null {
  for (const feature of geojson.features) {
    const kind = classifyGeometry(feature.geometry);
    if (kind) return kind;
  }
  return null;
}

function classifyGeometry(
  geometry: Geometry | null,
): "polygon" | "line" | "point" | null {
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
function buildLayerSpec(
  layer: GeoLibreLayer,
): Record<string, unknown> | null {
  if (!layer.geojson) return null;
  const kind = geometryKind(layer.geojson);
  if (!kind) return null;

  if (kind === "polygon") {
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
      "circle-opacity": 1,
    },
  };
}

function renderTemplate(
  config: Record<string, unknown>,
  inlineLayerScript: string,
): string {
  const configJson = jsonForScript(config, 4);
  return `<!DOCTYPE html>
<html>

<head>
    <meta charset='utf-8' />
    <title>${escapeHtml(String(config.title || "Story Map"))}</title>
    <meta name='viewport' content='initial-scale=1,maximum-scale=1,user-scalable=no' />
    <script src='https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js'></script>
    <link href='https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css' rel='stylesheet' />
    <script src="https://unpkg.com/scrollama@3.2.0"></script>
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
        .step { padding-bottom: 50vh; opacity: 0.25; }
        .step.active { opacity: 0.9; }
        .step div { padding: 25px 50px; line-height: 25px; font-size: 13px; }
        .step img { width: 100%; }
        @media (max-width: 750px) { .centered, .lefty, .righty, .fully { width: 90vw; margin: 0 auto; } }
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

        function getLayerPaintType(layer) { return layerTypes[map.getLayer(layer).type]; }
        function setLayerOpacity(layer) {
            var paintProps = getLayerPaintType(layer.layer);
            if (!paintProps) return;
            paintProps.forEach(function (prop) {
                var options = {};
                if (layer.duration) {
                    map.setPaintProperty(layer.layer, prop + '-transition', { duration: layer.duration });
                }
                map.setPaintProperty(layer.layer, prop, layer.opacity, options);
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

        config.chapters.forEach(function (record, idx) {
            var container = document.createElement('div');
            var chapter = document.createElement('div');
            if (record.title) { var h = document.createElement('h3'); h.innerText = record.title; chapter.appendChild(h); }
            if (record.image) { var img = new Image(); img.src = record.image; chapter.appendChild(img); }
            if (record.description) { var p = document.createElement('p'); p.innerHTML = record.description; chapter.appendChild(p); }
            container.setAttribute('id', record.id);
            container.classList.add('step');
            if (idx === 0) container.classList.add('active');
            chapter.classList.add(config.theme);
            container.appendChild(chapter);
            container.classList.add(alignments[record.alignment] || 'centered');
            if (record.hidden) container.classList.add('hidden');
            features.appendChild(container);
        });
        story.appendChild(features);

        var footer = document.createElement('div');
        if (config.footer) { var f = document.createElement('p'); f.innerHTML = config.footer; footer.appendChild(f); }
        if (footer.children.length > 0) { footer.classList.add(config.theme); footer.setAttribute('id', 'footer'); story.appendChild(footer); }

        var map = new maplibregl.Map({
            container: 'map',
            style: config.style,
            center: config.chapters[0].location.center,
            zoom: config.chapters[0].location.zoom,
            bearing: config.chapters[0].location.bearing,
            pitch: config.chapters[0].location.pitch,
            interactive: false
        });

        var insetMap = null, insetMarker = null;
        if (config.inset) {
            var insetContainer = document.createElement('div');
            insetContainer.id = 'inset-map';
            insetContainer.classList.add(config.insetPosition || 'bottom-right');
            document.body.appendChild(insetContainer);
            insetMap = new maplibregl.Map({ container: 'inset-map', style: config.insetStyle, center: config.chapters[0].location.center, zoom: config.insetZoom || 1, interactive: false, attributionControl: false });
            var markerEl = document.createElement('div');
            markerEl.className = 'inset-marker';
            insetMarker = new maplibregl.Marker({ element: markerEl }).setLngLat(config.chapters[0].location.center).addTo(insetMap);
        }

        var marker = null;
        if (config.showMarkers) {
            marker = new maplibregl.Marker({ color: config.markerColor });
            marker.setLngLat(config.chapters[0].location.center).addTo(map);
        }

        var scroller = scrollama();

        map.on('load', function () {
${inlineLayerScript}

            scroller.setup({ step: '.step', offset: 0.5, progress: true })
                .onStepEnter(function (response) {
                    var idx = config.chapters.findIndex(function (c) { return c.id === response.element.id; });
                    var chapter = config.chapters[idx];
                    response.element.classList.add('active');
                    map[chapter.mapAnimation || 'flyTo'](chapter.location);
                    if (config.showMarkers && marker) marker.setLngLat(chapter.location.center);
                    if (insetMap && insetMarker) { insetMap.setCenter(chapter.location.center); insetMarker.setLngLat(chapter.location.center); }
                    if (chapter.onChapterEnter.length > 0) chapter.onChapterEnter.forEach(setLayerOpacity);
                    if (chapter.rotateAnimation) {
                        map.once('moveend', function () {
                            var bearing = map.getBearing();
                            map.rotateTo(bearing + 180, { duration: 30000, easing: function (t) { return t; } });
                        });
                    }
                })
                .onStepExit(function (response) {
                    var chapter = config.chapters.find(function (c) { return c.id === response.element.id; });
                    response.element.classList.remove('active');
                    if (chapter.onChapterExit.length > 0) chapter.onChapterExit.forEach(setLayerOpacity);
                });
        });

        window.addEventListener('resize', scroller.resize);
    </script>
</body>

</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
