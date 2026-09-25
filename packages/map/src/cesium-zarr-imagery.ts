import { interpolateRampColors, type GeoLibreLayer } from "@geolibre/core";
import type { ImageryProvider } from "@cesium/engine";
import {
  assertSecureRequestHeaders,
  KerchunkReferenceStore,
  type KerchunkRefs,
} from "./kerchunk-reference-store";
import { getZarrStore, zarrRequestHeaders } from "./zarr-source";

// Zarr layers on the globe (opengeos/GeoLibre#2261).
//
// On the 2D map a Zarr layer is a `@carbonplan/zarr-layer` custom WebGL layer
// owned by the Zarr control, which is MapLibre-only. The globe instead draws it
// with zarr-cesium's `ZarrLayerProvider`, a Cesium imagery provider that reads
// the store with zarrita and colours each tile on the GPU. It is fed from the
// same layer record the 2D control and the ArcGIS renderer read: the store URL
// (or the registered store / kerchunk manifest), the variable, the selector,
// the colour limits, and the colour ramp.
//
// The module is injected (type-only import), so neither zarr-cesium nor its
// colormap tables reach the 2D boot path: `CesiumLayerSync` imports it on the
// first Zarr layer the globe draws.

type CesiumNs = typeof import("@cesium/engine");
type ZarrCesium = typeof import("zarr-cesium");
type ZarrLayerProvider = import("zarr-cesium").ZarrLayerProvider;
type ZarrSelectorsProps = import("zarr-cesium").ZarrSelectorsProps;

/** The part of the zarr-cesium module the globe uses. */
export type ZarrCesiumModule = Pick<ZarrCesium, "ZarrLayerProvider">;

/** Colour stops the ramp is sampled to when the layer names a GeoLibre ramp. */
const RAMP_STOPS = 256;

/** Every provider this module built, so teardown can tell them apart from others. */
const zarrProviders = new WeakSet<object>();

/** Whether `provider` is a Zarr imagery provider built by {@link createZarrImageryProvider}. */
export function isZarrImageryProvider(provider: unknown): provider is ZarrLayerProvider {
  return typeof provider === "object" && provider !== null && zarrProviders.has(provider);
}

function spatialDimensions(layer: GeoLibreLayer): { lat?: string; lon?: string } {
  const spatial = layer.source.spatialDimensions as { lat?: unknown; lon?: unknown } | undefined;
  return {
    ...(typeof spatial?.lat === "string" && spatial.lat ? { lat: spatial.lat } : {}),
    ...(typeof spatial?.lon === "string" && spatial.lon ? { lon: spatial.lon } : {}),
  };
}

/**
 * The non-spatial dimension names zarr-cesium recognises by itself, keyed by
 * the name it files their selector under. Mirrors `DIMENSION_ALIASES_DEFAULT`
 * from zarr-maps-tiling (matched case-insensitively, as it does);
 * `tests/cesium-zarr-imagery.test.ts` compares the two so drift fails CI.
 */
export const ZARR_DIMENSION_ALIASES: Readonly<Record<"time" | "elevation", readonly string[]>> = {
  time: ["time", "t", "Time", "time_counter"],
  elevation: ["depth", "z", "Depth", "level", "lev", "deptht", "elevation", "depthu", "depthv"],
};

/**
 * The key zarr-cesium reads a dimension's selector from: `"time"` or
 * `"elevation"` for a name it recognises, else the name itself (which is then
 * handed to it as an extra dimension, see {@link extraDimensions}).
 */
function selectorKey(name: string): string {
  return recognisedKey(name) ?? name;
}

/** The zarr-cesium key a dimension name is recognised under, if any. */
function recognisedKey(name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, aliases] of Object.entries(ZARR_DIMENSION_ALIASES)) {
    if (aliases.some((alias) => alias.toLowerCase() === lower)) return key;
  }
  return undefined;
}

/**
 * Selected dimensions zarr-cesium does not recognise by name. They are named to
 * it at construction as `dimensionNames.others`, so a selector on a `band` or
 * `month` dimension reaches the array.
 */
function extraDimensions(layer: GeoLibreLayer): string[] {
  const spatial = spatialDimensions(layer);
  return Object.keys(storeSelector(layer))
    .filter((name) => name !== spatial.lat && name !== spatial.lon && !recognisedKey(name))
    .sort();
}

function storeSelector(layer: GeoLibreLayer): Record<string, unknown> {
  const selector = layer.source.selector;
  return selector && typeof selector === "object" && !Array.isArray(selector)
    ? (selector as Record<string, unknown>)
    : {};
}

/**
 * The CRS zarr-cesium should place the grid in, or null to let it detect one.
 *
 * zarr-cesium places geographic (EPSG:4326) and Web Mercator (EPSG:3857) grids
 * only. A store the 2D map reprojects through proj4 cannot be drawn on the
 * globe yet, so it is refused here with a message the layer panel shows,
 * rather than being drawn in the wrong place.
 *
 * @param layer - The Zarr layer.
 * @returns The CRS code, or null when the layer names none.
 * @throws When the layer names a CRS the globe cannot place.
 */
export function zarrGlobeCrs(layer: GeoLibreLayer): "EPSG:4326" | "EPSG:3857" | null {
  const proj4 = typeof layer.source.proj4 === "string" ? layer.source.proj4.trim() : "";
  const crs = typeof layer.source.crs === "string" ? layer.source.crs.trim() : "";
  const code = /^(?:EPSG:)?(\d+)$/i.exec(crs)?.[1];
  if (code === "4326") return "EPSG:4326";
  if (code === "3857" || code === "900913" || code === "102100") return "EPSG:3857";
  if (crs || proj4) {
    throw new Error(
      `The 3D globe draws Zarr grids in EPSG:4326 or EPSG:3857 only, not ${crs || "a custom proj4 CRS"}`,
    );
  }
  return null;
}

/**
 * Translate the layer's selector into zarr-cesium's form.
 *
 * GeoLibre stores a Zarr selector as `{ [dimension]: value }`. A number is an
 * array index, as the Time Slider writes it and the ArcGIS renderer reads it; a
 * string is a coordinate value (a band name, an ISO date); an object already in
 * `{ selected, type }` form passes through.
 *
 * @param selector - The layer's `source.selector`.
 * @returns Selectors keyed as zarr-cesium reads them: `"time"`/`"elevation"`
 *   for the dimension names it recognises, else the store's own name.
 */
export function zarrGlobeSelectors(
  selector: Record<string, unknown>,
): Record<string, ZarrSelectorsProps> {
  const result: Record<string, ZarrSelectorsProps> = {};
  for (const [dimension, value] of Object.entries(selector)) {
    const name = selectorKey(dimension);
    if (typeof value === "number" && Number.isFinite(value)) {
      result[name] = { selected: Math.max(0, Math.round(value)), type: "index" };
    } else if (typeof value === "string") {
      result[name] = { selected: value, type: "value" };
    } else if (value && typeof value === "object" && "selected" in value) {
      const { selected, type } = value as { selected: unknown; type?: unknown };
      if (
        typeof selected === "number" ||
        typeof selected === "string" ||
        (Array.isArray(selected) &&
          selected.length === 2 &&
          selected.every((part) => typeof part === "number"))
      ) {
        result[name] = {
          selected: selected as ZarrSelectorsProps["selected"],
          ...(type === "index" || type === "value" ? { type } : {}),
        };
      }
    }
  }
  return result;
}

/**
 * The layer's colour limits as zarr-cesium's `scale`.
 *
 * @param layer - The Zarr layer.
 * @returns `[min, max]`, falling back to `[0, 1]` for missing or inverted limits.
 */
export function zarrGlobeScale(layer: GeoLibreLayer): [number, number] {
  const clim = layer.source.clim;
  if (Array.isArray(clim) && clim.length === 2) {
    const [min, max] = clim.map(Number);
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) return [min, max];
  }
  return [0, 1];
}

/**
 * The layer's colour ramp as `[r, g, b]` triplets in 0..1.
 *
 * `source.colormap` is the list of CSS colours the 2D control draws with, or a
 * GeoLibre ramp name. Unit floats (rather than 0..255 bytes) are what the
 * renderer is given, because it decides the scale from the first stop: a byte
 * ramp that opens on black (magma, inferno) would read as floats.
 *
 * @param Cesium - The engine namespace, for its CSS colour parser.
 * @param layer - The Zarr layer.
 * @returns At least two colour stops.
 */
export function zarrGlobeColors(
  Cesium: CesiumNs,
  layer: GeoLibreLayer,
): [number, number, number][] {
  const colormap = layer.source.colormap;
  const css =
    Array.isArray(colormap) && colormap.length > 0
      ? colormap.map(String)
      : interpolateRampColors(
          typeof colormap === "string" && colormap.trim() ? colormap.trim() : "viridis",
          RAMP_STOPS,
        );
  const colors: [number, number, number][] = [];
  for (const value of css) {
    const color = Cesium.Color.fromCssColorString(value);
    if (color) colors.push([color.red, color.green, color.blue]);
  }
  if (colors.length >= 2) return colors;
  return interpolateRampColors("viridis", RAMP_STOPS).map((value) => {
    const color = Cesium.Color.fromCssColorString(value)!;
    return [color.red, color.green, color.blue];
  });
}

/**
 * The layer fields that decide how the store is opened. A change to any of them
 * builds a new provider; everything else is applied to the live one.
 *
 * Selected dimensions zarr-cesium does not recognise by name are part of it,
 * because they are handed to the provider at construction; the selector's
 * values are not, and neither is a newly selected `time` (the first Time
 * Slider step on a layer added with no selector).
 *
 * @param layer - The Zarr layer.
 * @returns A comparable key.
 */
export function zarrOpenSignature(layer: GeoLibreLayer): string {
  const source = layer.source;
  return JSON.stringify([
    source.url ?? null,
    source.variable ?? null,
    source.crs ?? null,
    source.proj4 ?? null,
    spatialDimensions(layer),
    extraDimensions(layer),
    // Only whether a manifest is present: re-reading one swaps the object
    // without changing what the URL resolves to.
    Boolean(source.kerchunkRefs),
    zarrRequestHeaders(layer) ?? null,
  ]);
}

/**
 * The layer fields applied to a live provider in place: the selector values,
 * the colour limits, and the ramp.
 *
 * @param layer - The Zarr layer.
 * @returns A comparable key.
 */
export function zarrRenderSignature(layer: GeoLibreLayer): string {
  const source = layer.source;
  return JSON.stringify([source.selector ?? null, source.clim ?? null, source.colormap ?? null]);
}

/**
 * The parts of zarr-maps-tiling's tile renderer the colour injection touches.
 *
 * `ZarrLayerProvider` honours only named matplotlib colormaps (its documented
 * `colorScale` option is not passed through to the renderer in 0.3.3), while a
 * GeoLibre layer carries its own ramp. The renderer keeps its ramp in
 * `colorScale.colors` and uploads it with `updateColormapTexture()`, so the
 * globe writes the layer's ramp there. Both are real members the package does
 * not type publicly; `tests/cesium-zarr-imagery.test.ts` asserts they still
 * exist so a rename fails CI instead of silently drawing the default ramp.
 */
interface TileRendererInternals {
  colorScale?: { colors?: unknown };
  updateColormapTexture?: () => void;
}

let warnedColorInjection = false;

/**
 * Draw `provider`'s tiles with the layer's own ramp.
 *
 * @returns Whether the ramp was applied.
 */
function applyColors(provider: ZarrLayerProvider, colors: [number, number, number][]): boolean {
  const renderer = (provider as unknown as { source?: TileRendererInternals }).source;
  if (
    !renderer?.colorScale ||
    typeof renderer.colorScale !== "object" ||
    typeof renderer.updateColormapTexture !== "function"
  ) {
    if (!warnedColorInjection) {
      warnedColorInjection = true;
      console.warn("[zarr] zarr-cesium internals changed; the globe draws its default ramp");
    }
    return false;
  }
  renderer.colorScale.colors = colors;
  renderer.updateColormapTexture();
  return true;
}

/**
 * Bring a live provider in line with `next`: selector values, colour limits,
 * and ramp. Selector dimensions `prev` set and `next` dropped go back to index
 * 0, the default for an unselected dimension.
 *
 * @param Cesium - The engine namespace.
 * @param provider - The provider {@link createZarrImageryProvider} built.
 * @param prev - The layer the provider last drew, or undefined on first use.
 * @param next - The layer to draw.
 * @returns Whether rendered pixels change, i.e. the imagery must be refreshed.
 */
export function applyZarrRender(
  Cesium: CesiumNs,
  provider: ZarrLayerProvider,
  prev: GeoLibreLayer | undefined,
  next: GeoLibreLayer,
): boolean {
  if (prev && zarrRenderSignature(prev) === zarrRenderSignature(next)) return false;
  const selectors = zarrGlobeSelectors(storeSelector(next));
  if (prev) {
    for (const name of Object.keys(storeSelector(prev)).map(selectorKey)) {
      if (!(name in selectors)) selectors[name] = { selected: 0, type: "index" };
    }
  }
  let changed = provider.updateSelectors(selectors);
  changed = provider.updateStyle({ scale: zarrGlobeScale(next) }) || changed;
  if (!prev || JSON.stringify(prev.source.colormap) !== JSON.stringify(next.source.colormap)) {
    changed = applyColors(provider, zarrGlobeColors(Cesium, next)) || changed;
  }
  return changed;
}

/**
 * Build the globe's imagery provider for a Zarr layer and wait until it has read
 * the store's metadata.
 *
 * The store comes from the same places the 2D control and the ArcGIS renderer
 * read it from: a store registered for the layer (a local folder, an Icechunk
 * repository), then a kerchunk manifest, then the URL itself with the
 * session's request headers.
 *
 * @param Cesium - The engine namespace.
 * @param zarrCesium - The zarr-cesium module.
 * @param layer - The Zarr layer.
 * @returns A ready provider drawing the layer's selection, limits, and ramp.
 * @throws When the layer has no variable, names a CRS the globe cannot place,
 *   or the store cannot be opened.
 */
export async function createZarrImageryProvider(
  Cesium: CesiumNs,
  zarrCesium: ZarrCesiumModule,
  layer: GeoLibreLayer,
): Promise<ImageryProvider> {
  const source = layer.source;
  const url = typeof source.url === "string" ? source.url.trim() : "";
  const variable = typeof source.variable === "string" ? source.variable.trim() : "";
  if (!variable) throw new Error("A Zarr variable is required");
  const crs = zarrGlobeCrs(layer);
  const headers = zarrRequestHeaders(layer);
  let store = getZarrStore(layer.id) as import("zarrita").Readable | undefined;
  if (!store && source.kerchunkRefs) {
    store = new KerchunkReferenceStore(source.kerchunkRefs as KerchunkRefs, {
      headers,
      sourceUrl: url,
    });
  }
  if (!store) {
    if (!url) throw new Error("The Zarr layer has no store URL");
    assertSecureRequestHeaders(url, headers);
  }
  const spatial = spatialDimensions(layer);
  const others = extraDimensions(layer);
  const provider = new zarrCesium.ZarrLayerProvider({
    ...(store ? { store } : { url }),
    variable,
    crs,
    scale: zarrGlobeScale(layer),
    selectors: zarrGlobeSelectors(storeSelector(layer)),
    dimensionNames: { ...spatial, ...(others.length ? { others } : {}) },
    ...(!store && headers && Object.keys(headers).length
      ? { requestOverrides: { headers, redirect: "error" as const } }
      : {}),
  });
  let ready = false;
  try {
    ready = await provider.readyPromise;
  } catch (error) {
    provider.destroy();
    throw error;
  }
  if (!ready) {
    provider.destroy();
    throw new Error(`Could not open the Zarr variable "${variable}"`);
  }
  applyColors(provider, zarrGlobeColors(Cesium, layer));
  zarrProviders.add(provider);
  return provider as unknown as ImageryProvider;
}
