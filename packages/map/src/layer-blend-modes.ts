/**
 * Per-layer cartographic blend modes (opengeos/GeoLibre#1981).
 *
 * MapLibre draws every style layer into one WebGL canvas, so a CSS
 * `mix-blend-mode` on the canvas would blend the whole map against the page
 * rather than one layer against the layers under it. MapLibre also exposes no
 * public per-layer blend API (the upstream draft is
 * maplibre/maplibre-gl-js#8073). What it *does* expose, internally, is the two
 * seams this module drives:
 *
 * 1. `Painter.prototype.renderLayer` runs once per style layer per pass and
 *    receives that layer, so it can bracket the layer's draws.
 * 2. `Context.prototype.setColorMode` is the single place every program draw
 *    resolves its GL blend state, through the `blend` / `blendFunc` /
 *    `blendEquation` state wrappers.
 *
 * Wrapping those two lets a chosen `blendFunc` + `blendEquation` pair stand in
 * for MapLibre's usual alpha compositing while one registered layer draws. The
 * result is real GPU blending in the correct z-position of the same canvas --
 * not an overlay, a second map, or a CSS approximation.
 *
 * **Fill and line layers blend as a whole layer, not per primitive.** MapLibre
 * 6.3 renders a fill or line layer whose `fill-layer-opacity` /
 * `line-layer-opacity` is below 1 into a scratch framebuffer and composites it
 * in a single draw with the `layerOpacity` program (`drawLayerOpacity`). That
 * is exactly the semantics a cartographic blend mode wants: two overlapping
 * polygons in one layer must not multiply against each other, only against the
 * map beneath. So `style-mapper` pins those properties just under 1 for a
 * blended layer (see `LAYER_OPACITY_FOR_BLEND`) to elect that path, and this
 * module applies the blend only to the final composite draw -- identified by
 * the program MapLibre asked for -- leaving the draws *into* the scratch buffer
 * on ordinary alpha blending.
 *
 * Every other layer type has no such composite pass and blends per draw. For
 * raster -- the case #1981 was filed for -- that is equivalent, because tiles
 * do not overlap within a layer. For `circle` and `fill-extrusion` it is NOT:
 * symbols that overlap on screen blend against each other as well as against
 * the map, so an overlap darkens twice under Multiply (measured at
 * `rgb(23, 77, 220)` in the overlap against `rgb(76, 136, 222)` on a single
 * symbol, where ordinary alpha compositing differs by a fraction of that).
 * This is a MapLibre limitation, not a choice: `fill-layer-opacity` and
 * `line-layer-opacity` are the only layer-level composites the style spec
 * defines, so there is nothing to elect for the other types. The control is
 * still offered for them -- blending sparse points over a hillshade is a real
 * use -- and `docs/user-guide/layers.md` documents the overlap caveat.
 *
 * All three internals are unexported, so `tests/layer-blend-modes.test.ts`
 * asserts their shape against a real `maplibre-gl` build and fails on a bump
 * that moves them. {@link installLayerBlendModes} additionally feature-detects
 * every seam at runtime and disables the feature rather than breaking the map
 * if one is missing.
 */
import type * as maplibregl from "maplibre-gl";
import {
  DEFAULT_BLEND_MODE,
  DEFAULT_LAYER_STYLE,
  type BlendMode,
  type GeoLibreLayer,
} from "@geolibre/core";

/**
 * The `fill-layer-opacity` / `line-layer-opacity` value a blended fill or line
 * layer is pinned to. Any value below 1 elects MapLibre's render-to-texture
 * composite path; this one is close enough to opaque that the extra multiply in
 * the composite shader is not representable in 8-bit colour, so electing the
 * path costs no visible fading.
 */
export const LAYER_OPACITY_FOR_BLEND = 0.999;

/** The subset of WebGL constants {@link blendSpecFor} resolves a mode against. */
export interface BlendConstants {
  ONE: number;
  DST_COLOR: number;
  ONE_MINUS_SRC_COLOR: number;
  ONE_MINUS_SRC_ALPHA: number;
  FUNC_ADD: number;
  MAX: number;
}

/** A resolved GL blend state: the `blendFunc` pair and the `blendEquation`. */
export interface BlendSpec {
  func: [number, number];
  equation: number;
}

/**
 * The GL blend state for a mode, or `null` for `"normal"` (and for anything
 * unrecognized, so an unknown value read from a project file renders normally
 * instead of throwing).
 *
 * Source colours arriving here are premultiplied by their alpha, which is what
 * makes the destination factors below degrade correctly where a layer is
 * partly transparent: at `srcAlpha === 0` every mode reduces to leaving the
 * destination untouched. That is a hard requirement, not a nicety -- MapLibre
 * composites a blended fill or line as one viewport-filling quad, so a mode
 * that turned a transparent source into anything but "leave the destination
 * alone" would repaint the whole map. It is what rules out the MIN and
 * reverse-subtract modes; see `BLEND_MODES` in `@geolibre/core`.
 */
export function blendSpecFor(mode: BlendMode | undefined, gl: BlendConstants): BlendSpec | null {
  switch (mode) {
    case "multiply":
      // src*dst + dst*(1-srcA): the product where the layer is opaque, the
      // untouched backdrop where it is not.
      return { func: [gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA], equation: gl.FUNC_ADD };
    case "screen":
      // src + dst*(1-src): the inverse-multiply-of-inverses, i.e. lightening.
      return { func: [gl.ONE, gl.ONE_MINUS_SRC_COLOR], equation: gl.FUNC_ADD };
    case "lighten":
      // MAX ignores the factors and takes the per-channel maximum, which is
      // also why it is safe: `max(0, dst)` is `dst`, so the untouched map
      // survives outside the layer and the canvas keeps `max(srcA, 1) === 1`.
      // Its mirror image, MIN, is not safe and is not offered -- see BLEND_MODES.
      return { func: [gl.ONE, gl.ONE], equation: gl.MAX };
    case "add":
      return { func: [gl.ONE, gl.ONE], equation: gl.FUNC_ADD };
    default:
      return null;
  }
}

/** Whether a style's mode asks for anything other than ordinary compositing. */
export function isBlending(mode: BlendMode | undefined): boolean {
  return blendSpecFor(mode, IDENTITY_CONSTANTS) !== null;
}

// Only ever fed to blendSpecFor's `null`/non-null discrimination, never to GL.
const IDENTITY_CONSTANTS: BlendConstants = {
  ONE: 1,
  DST_COLOR: 2,
  ONE_MINUS_SRC_COLOR: 3,
  ONE_MINUS_SRC_ALPHA: 4,
  FUNC_ADD: 5,
  MAX: 6,
};

/**
 * Native sub-layer suffixes kept out of blending.
 *
 * A layer's labels are chrome, not cartography: multiplying a place name into a
 * dark hillshade is how you lose it. MapLibre's own `symbol` layers for text
 * (and the cluster counts drawn the same way) therefore keep ordinary alpha
 * compositing even when their owning layer blends. Icon markers are *not* in
 * this list -- they are symbology, and blend with the rest of the layer.
 */
const UNBLENDED_SUFFIXES = ["-text", "-label", "-cluster-count"] as const;

/**
 * The style layers GeoLibre generates for one store layer are all named
 * `layer-<layerId>-<role>` (see `geojson-loader`), while single-native-layer
 * types (raster, XYZ, WMS, …) reuse the store id verbatim and plugin-managed
 * layers name their own. Registering a prefix rather than enumerating roles
 * means a layer picks up blending on sub-layers added later (geometry
 * generators, inverted fills, line decorations) with nothing to keep in sync.
 */
interface Registration {
  mode: BlendMode;
  /** Exact native style-layer ids (single-native-layer and plugin layers). */
  exact: string[];
  /** `layer-<layerId>-` prefix covering the generated sub-layers. */
  prefix: string;
}

const registrations = new Map<string, Registration>();
/**
 * The `layer-<layerId>-` prefix of EVERY layer on the map, blending or not,
 * longest first.
 *
 * Prefix matching needs to know about layers that do not blend, not just the
 * ones that do. `region` blending and `region-2` not would otherwise leave
 * `layer-region-2-fill` matching `region`'s prefix with nothing registered to
 * contest it, so a layer explicitly set to Normal would blend. Comparing
 * against every layer's prefix means the longest match is always the owning
 * layer, and a non-blending owner correctly resolves to no mode.
 */
let layerPrefixes: { prefix: string; layerId: string }[] = [];
/** Memoized native-id → mode lookups; dropped on every sync. */
let resolved = new Map<string, BlendMode | null>();

function modeForNativeLayer(nativeLayerId: string): BlendMode | null {
  // The overwhelmingly common case: nothing on the map blends. Answer without
  // touching the cache, so a session that never sets a mode cannot accumulate
  // an entry per native style layer it has ever drawn.
  if (registrations.size === 0) return null;
  const cached = resolved.get(nativeLayerId);
  if (cached !== undefined) return cached;
  let mode: BlendMode | null = null;
  if (!UNBLENDED_SUFFIXES.some((suffix) => nativeLayerId.endsWith(suffix))) {
    // An exact match outranks any prefix match, however long: naming a native
    // layer id is an explicit claim by the layer's control, while a prefix is
    // inferred from GeoLibre's own naming. The two can only collide if a
    // project declares a `nativeLayerIds` entry spelled like another layer's
    // generated sub-layer, which is a malformed project rather than a case
    // with a right answer.
    const exact = [...registrations.values()].find((registration) =>
      registration.exact.includes(nativeLayerId),
    );
    if (exact) {
      mode = exact.mode;
    } else {
      // Longest prefix wins, not first match, and the search runs over every
      // layer rather than only the blending ones -- see `layerPrefixes`. Store
      // layer ids are UUIDs when data is added through the app, but a
      // hand-authored or MCP-authored `.geolibre.json` may carry any string,
      // and ids like `abc` and `abc-2` both prefix `layer-abc-2-fill`. The
      // longer prefix is always the owning layer, because the extra characters
      // are part of its id.
      const owner = layerPrefixes.find((entry) => nativeLayerId.startsWith(entry.prefix));
      mode = owner ? (registrations.get(owner.layerId)?.mode ?? null) : null;
    }
  }
  resolved.set(nativeLayerId, mode);
  return mode;
}

/** Native style-layer ids a store layer may own beyond its generated prefix. */
function exactNativeLayerIds(layer: GeoLibreLayer): string[] {
  const declared = layer.metadata?.nativeLayerIds;
  const ids = Array.isArray(declared)
    ? declared.filter((id): id is string => typeof id === "string")
    : [];
  // Single-native-layer types (raster, xyz, wms, wmts, video, image, …) render
  // into a style layer named for the store layer itself.
  return ids.length > 0 ? ids : [layer.id];
}

/**
 * A compact fingerprint of which layers blend and with what.
 *
 * {@link syncLayerBlendModes} reports whether the *global* registry changed,
 * which cannot drive a repaint on its own: the registry is module-level and
 * shared by every `MapController`, so in a split view the first pane to sync
 * wins the diff and every other pane is told nothing changed. Each controller
 * therefore compares this signature against its own previous one, so all panes
 * repaint for a mode that changes no paint property (raster, circle,
 * fill-extrusion), and all of them repaint when the last mode is cleared.
 */
export function blendModeSignature(layers: readonly GeoLibreLayer[]): string {
  // Only the blending layers appear, so a map where nothing blends has the same
  // (empty) signature before and after every sync and never asks for a frame it
  // does not need. Clearing the last mode still changes the signature to empty
  // from non-empty, which is the repaint that restores the layer.
  return layers
    .filter((layer) => isBlending(layer.style?.blendMode ?? DEFAULT_BLEND_MODE))
    .map((layer) => `${layer.id}:${layer.style?.blendMode}`)
    .join("|");
}

/**
 * Reconcile the blend registry with the current layer list.
 *
 * Called from `MapController.syncLayers`, which already runs on every store
 * change, so a mode set, cleared, or arriving with an opened project all land
 * here. Returns whether anything changed, so the caller can skip a repaint.
 */
export function syncLayerBlendModes(layers: readonly GeoLibreLayer[]): boolean {
  const next = new Map<string, Registration>();
  for (const layer of layers) {
    const mode = layer.style?.blendMode ?? DEFAULT_LAYER_STYLE.blendMode;
    if (!isBlending(mode)) continue;
    next.set(layer.id, {
      mode: mode as BlendMode,
      exact: exactNativeLayerIds(layer),
      prefix: `layer-${layer.id}-`,
    });
  }

  // Longest first, so `modeForNativeLayer` can take the first match. Rebuilt
  // from the full layer list, not just the blending subset, so a layer left on
  // Normal still shadows a shorter-id neighbour's prefix.
  layerPrefixes = layers
    .map((layer) => ({ prefix: `layer-${layer.id}-`, layerId: layer.id }))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  // Dropped on every sync, not only when the registry changed: entries are
  // keyed by native style-layer id, so a session that adds and discards layers
  // (repeated Processing runs, say) would otherwise keep one per id it has ever
  // drawn for the lifetime of the page. Rebuilding is a handful of string
  // comparisons per layer against a registry that is normally one or two
  // entries, and syncs happen on store changes rather than per frame.
  resolved = new Map();

  if (!registrationsChanged(registrations, next)) return false;
  registrations.clear();
  for (const [id, registration] of next) registrations.set(id, registration);
  return true;
}

function registrationsChanged(
  current: Map<string, Registration>,
  next: Map<string, Registration>,
): boolean {
  if (current.size !== next.size) return true;
  for (const [id, registration] of next) {
    const previous = current.get(id);
    if (!previous) return true;
    if (previous.mode !== registration.mode) return true;
    if (previous.prefix !== registration.prefix) return true;
    if (previous.exact.length !== registration.exact.length) return true;
    if (previous.exact.some((value, index) => value !== registration.exact[index])) return true;
  }
  return false;
}

/**
 * Drops every registration. Exposed for tests.
 *
 * Deliberately NOT called from `MapController.destroy()`: the registry is
 * module-global and shared by every map, so tearing one pane of a split view
 * down would clear the other pane's modes until its next sync. Nothing leaks by
 * leaving it -- `syncLayerBlendModes` rebuilds the whole registry from the live
 * layer list on every sync, so a destroyed map's entries are replaced rather
 * than accumulating.
 */
export function resetLayerBlendModes(): void {
  registrations.clear();
  layerPrefixes = [];
  resolved = new Map();
}

/** The mode a native style layer currently renders with. Exposed for tests. */
export function blendModeForNativeLayer(nativeLayerId: string): BlendMode | null {
  return modeForNativeLayer(nativeLayerId);
}

// --- the MapLibre seam -----------------------------------------------------

/** A MapLibre `Context` state wrapper: a dirty-tracked GL setter. */
interface StateValue<T> {
  set(value: T): void;
}

interface PainterContext {
  gl: WebGL2RenderingContext;
  blend: StateValue<boolean>;
  blendFunc: StateValue<[number, number]>;
  blendEquation: StateValue<number>;
  setColorMode(colorMode: { mask: boolean[] }): void;
}

interface PainterLike {
  context: PainterContext;
  renderLayer(...args: unknown[]): unknown;
  useProgram(name: string, ...rest: unknown[]): unknown;
}

/**
 * The style layer among `renderLayer`'s arguments.
 *
 * `maplibre-gl` passes it third today, but the signature is internal and could
 * be reordered by a bump without renaming the method, which the bundle-shape
 * drift test would not catch. Reading it by shape rather than by position keeps
 * blending working through a reorder; the loud guard for the whole mechanism is
 * `e2e/blend-modes.spec.ts`, which asserts real pixels change per mode and so
 * fails in CI if this ever stops finding the layer.
 */
function styleLayerArgument(args: unknown[]): { id?: string; type?: string } | undefined {
  for (let index = 2; index < args.length + 2; index += 1) {
    const candidate = args[index % args.length] as { id?: unknown; type?: unknown } | undefined;
    if (typeof candidate?.id === "string" && typeof candidate.type === "string") {
      return candidate as { id: string; type: string };
    }
  }
  return undefined;
}

/** Marks a prototype this module has already wrapped (prototypes are shared). */
const PATCHED = Symbol.for("geolibre.layerBlendModes.patched");

/**
 * The layer currently rendering, if it blends. Read inside `setColorMode`,
 * which MapLibre only ever calls synchronously within a `renderLayer` call, so
 * a plain module variable is enough -- there is no interleaving to guard.
 */
let active: { spec: BlendSpec; compositeOnly: boolean } | null = null;
/** The program name of the draw about to issue, per the `useProgram` wrapper. */
let lastProgram: string | null = null;
/** `null` until a map has been installed and the seams actually probed. */
let supported: boolean | null = null;
const supportListeners = new Set<() => void>();

/**
 * Whether the running `maplibre-gl` exposed every seam blending needs.
 *
 * Optimistic before the first {@link installLayerBlendModes} call, so a panel
 * that renders while the map is still initializing offers the control rather
 * than hiding it. The answer can therefore change once, from optimistic `true`
 * to `false`, when the map installs against a build that moved a seam --
 * subscribe with {@link subscribeLayerBlendModeSupport} to re-render on that.
 */
export function layerBlendModesSupported(): boolean {
  return supported !== false;
}

/**
 * Subscribe to changes in {@link layerBlendModesSupported}, for
 * `useSyncExternalStore`. Returns the unsubscribe function.
 *
 * Without this a panel rendered before the map installed would keep offering a
 * Blend control that cannot do anything, and would let a mode be saved into the
 * project that nothing will ever apply.
 */
export function subscribeLayerBlendModeSupport(listener: () => void): () => void {
  supportListeners.add(listener);
  return () => {
    supportListeners.delete(listener);
  };
}

function setSupported(next: boolean): void {
  if (supported === next) return;
  supported = next;
  for (const listener of supportListeners) listener();
}

/**
 * The layer types MapLibre can render through its scratch-framebuffer composite
 * (see the module comment); for those, only the final draw carries the mode.
 *
 * Exactly the types the style spec gives a `*-layer-opacity` paint property --
 * `fill` and `line`, and no others as of maplibre-gl 6.3. Adding a type here
 * without a corresponding `*-layer-opacity` in `style-mapper` would silently
 * disable blending for it, because the composite draw it waits for never comes.
 * `tests/layer-blend-modes.test.ts` checks this set against the style spec.
 */
const COMPOSITE_LAYER_TYPES = new Set(["fill", "line"]);
/** The program name MapLibre composites a layer-opacity render-to-texture with. */
const COMPOSITE_PROGRAM = "layerOpacity";

/**
 * Wrap the render loop of `map` so registered layers blend. Idempotent, and
 * safe to call for every map: the wrappers live on the shared prototypes and
 * are installed once, while the registry is global (a layer shown in a split
 * view's second pane must blend identically).
 *
 * @param map - The map whose painter supplies the prototypes to wrap.
 * @returns Whether blending is available; `false` leaves the map untouched.
 */
export function installLayerBlendModes(map: maplibregl.Map): boolean {
  const painter = (map as unknown as { painter?: PainterLike }).painter;
  // No painter yet means the map is mid-construction, not that blending is
  // unavailable, so leave the verdict undecided for the next call.
  if (!painter?.context) return layerBlendModesSupported();

  const painterProto = Object.getPrototypeOf(painter) as PainterLike & { [PATCHED]?: boolean };
  const contextProto = Object.getPrototypeOf(painter.context) as PainterContext & {
    [PATCHED]?: boolean;
  };
  const context = painter.context;

  const seamsPresent =
    typeof painterProto.renderLayer === "function" &&
    typeof painterProto.useProgram === "function" &&
    typeof contextProto.setColorMode === "function" &&
    typeof context.blend?.set === "function" &&
    typeof context.blendFunc?.set === "function" &&
    typeof context.blendEquation?.set === "function";
  if (!seamsPresent) {
    // A maplibre-gl bump moved something. Blending stays off (the Style panel
    // reads `layerBlendModesSupported`), and the map renders exactly as before.
    console.warn(
      "[geolibre] per-layer blend modes disabled: this maplibre-gl build does not expose the expected render seams",
    );
    setSupported(false);
    return false;
  }
  setSupported(true);
  if (painterProto[PATCHED] && contextProto[PATCHED]) return true;

  const gl = context.gl;

  if (!painterProto[PATCHED]) {
    const originalRenderLayer = painterProto.renderLayer;
    painterProto.renderLayer = function renderLayer(this: PainterLike, ...args: unknown[]) {
      const layer = styleLayerArgument(args);
      const previous = active;
      const mode = layer?.id ? modeForNativeLayer(layer.id) : null;
      const spec = mode ? blendSpecFor(mode, gl) : null;
      active = spec ? { spec, compositeOnly: COMPOSITE_LAYER_TYPES.has(layer?.type ?? "") } : null;
      try {
        return originalRenderLayer.apply(this, args);
      } finally {
        active = previous;
      }
    };

    const originalUseProgram = painterProto.useProgram;
    painterProto.useProgram = function useProgram(
      this: PainterLike,
      name: string,
      ...rest: unknown[]
    ) {
      lastProgram = name;
      return originalUseProgram.call(this, name, ...rest);
    };

    painterProto[PATCHED] = true;
  }

  if (!contextProto[PATCHED]) {
    const originalSetColorMode = contextProto.setColorMode;
    contextProto.setColorMode = function setColorMode(
      this: PainterContext,
      colorMode: { mask: boolean[] },
    ) {
      originalSetColorMode.call(this, colorMode);
      if (!active) {
        // `blendEquation` is dirty-tracked GL state that MapLibre itself never
        // moves off FUNC_ADD, so a mode that set MIN/MAX would otherwise leak
        // into every later draw. The wrapper no-ops when already correct.
        this.blendEquation.set(gl.FUNC_ADD);
        return;
      }
      // A fully masked-off colour write is a depth or stencil prepass; blending
      // it would be meaningless and can only confuse the state tracker.
      if (!colorMode.mask[0] && !colorMode.mask[1] && !colorMode.mask[2]) return;
      if (active.compositeOnly && lastProgram !== COMPOSITE_PROGRAM) {
        // Drawing *into* the scratch framebuffer: ordinary alpha compositing,
        // so overlapping features in one layer flatten before they blend.
        this.blendEquation.set(gl.FUNC_ADD);
        return;
      }
      this.blend.set(true);
      this.blendFunc.set(active.spec.func);
      this.blendEquation.set(active.spec.equation);
    };
    contextProto[PATCHED] = true;
  }

  return true;
}
