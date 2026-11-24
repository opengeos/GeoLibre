import { useAppStore } from "@geolibre/core";
import type { SourceSpec, TimeSliderConfig } from "maplibre-gl-time-slider";
import type { GeoLibreAppAPI } from "./types";
import { TIME_SLIDER_PLUGIN_ID } from "./plugin-ids";
import type { TimeBinding } from "./time-slider-binding";
import { isSelectorTimeBinding, type SelectorTimeBinding } from "./temporal-layers";

type TimeSliderRuntime = Pick<
  typeof import("./plugins/maplibre-time-slider"),
  "getActiveTimeSliderControl" | "applyTimeSliderConfig"
>;
let runtime: TimeSliderRuntime | undefined;

/** Publish the live dock helpers after either a catalog or SDK import. */
export function provideTimeSliderRuntime(provider: TimeSliderRuntime): void {
  runtime = provider;
}

/** Reading an unopened dock does not load its implementation. */
export function getActiveTimeSliderControl(): ReturnType<
  TimeSliderRuntime["getActiveTimeSliderControl"]
> {
  return runtime?.getActiveTimeSliderControl() ?? null;
}

/** Activate through the host so lazy setup, policy, and saved state precede edits. */
export async function applyTimeSliderConfig(
  app: GeoLibreAppAPI,
  build: (current: TimeSliderConfig | null) => TimeSliderConfig,
): Promise<boolean> {
  const generation = useAppStore.getState().projectGeneration;
  const renderer = app.getMapRenderer?.() ?? useAppStore.getState().primaryRenderer;
  if (!getActiveTimeSliderControl() && !(await app.activatePlugin?.(TIME_SLIDER_PLUGIN_ID)))
    return false;
  if (
    generation !== useAppStore.getState().projectGeneration ||
    renderer !== (app.getMapRenderer?.() ?? useAppStore.getState().primaryRenderer)
  )
    return false;
  return runtime?.applyTimeSliderConfig(app, build) ?? false;
}

/**
 * Marker placed on every GeoLibre store layer that mirrors a time-slider
 * source, used to reconcile and prune the plugin's layers without touching any
 * others (mirrors the Esri Wayback `sourceKind` convention).
 *
 * Exported as {@link TIME_SLIDER_SOURCE_KIND} so the Style panel can recognize
 * these layers and offer the symbology their dock source supports.
 */
export const TIME_SLIDER_SOURCE_KIND = "time-slider";

/**
 * Rebuilds the parts of a saved source that JSON cannot carry.
 *
 * @param spec - A source read back from a saved project.
 * @returns The source with its runtime parts restored, the source unchanged
 *   when it is not the rehydrator's, or null to drop a source that cannot be
 *   rebuilt.
 */
export type TimeSliderSourceRehydrator = (spec: SourceSpec) => SourceSpec | null | undefined;

const sourceRehydrators = new Set<TimeSliderSourceRehydrator>();

/**
 * Lets another plugin restore a source whose URL is a resolver function.
 *
 * The library accepts a function for a source's `url`/`tiles` (one URL per
 * date), and a function does not survive the project file. A plugin that adds
 * such a source also stores a serializable description on the spec and
 * registers a rehydrator here to turn that description back into the resolver
 * when the project is reopened (the Planetary Computer panel's dated stacks).
 *
 * @param rehydrator - Recognizes the plugin's sources and restores them.
 * @returns A function that unregisters the rehydrator.
 */
export function registerTimeSliderSourceRehydrator(
  rehydrator: TimeSliderSourceRehydrator,
): () => void {
  sourceRehydrators.add(rehydrator);
  return () => sourceRehydrators.delete(rehydrator);
}

export function rehydrateTimeSliderSources(sources: SourceSpec[]): SourceSpec[] {
  const restored: SourceSpec[] = [];
  for (const source of sources) {
    let next: SourceSpec | null = source;
    for (const rehydrator of sourceRehydrators) {
      const result: SourceSpec | null | undefined = rehydrator(next);
      if (result === null) {
        next = null;
        break;
      }
      if (result) next = result;
    }
    if (next) restored.push(next);
  }
  return restored;
}

/**
 * Read the binding stored on a layer's metadata, if any. Used by the Layers
 * panel to decide between the Bind and Unbind actions, and by
 * {@link isTimeSliderIdle}. Returns either kind: a vector-filter
 * {@link TimeBinding} or a data cube's {@link SelectorTimeBinding}.
 *
 * @param layer - A store layer.
 * @returns The binding, or `undefined` when the layer is not time-bound.
 */
export function getLayerTimeBinding(layer: {
  metadata?: Record<string, unknown>;
}): TimeBinding | SelectorTimeBinding | undefined {
  const binding = layer.metadata?.timeBinding;
  if (isSelectorTimeBinding(binding)) return binding;
  const filterBinding = binding as TimeBinding | undefined;
  return filterBinding && typeof filterBinding.property === "string" ? filterBinding : undefined;
}

/**
 * Whether the Time Slider has nothing left to drive. The Layers panel calls
 * this after removing a binding so the plugin switches itself off once the last
 * one is gone, rather than leaving the dock over a map it no longer affects.
 *
 * The slider drives three unrelated things, and all three have to be clear
 * before it is safe to switch off:
 *
 * - store layers carrying a binding, of either kind: a vector
 *   {@link TimeBinding} or a data cube's {@link SelectorTimeBinding};
 * - the dock's own sources (COG stacks, mosaics, tile templates added through
 *   its "Add data" form), which are mirrored into the store under
 *   {@link TIME_SLIDER_SOURCE_KIND};
 * - KML `<TimeSpan>` / `<TimeStamp>` ground overlays and placemark layers, which
 *   the slider animates by visibility rather than by filter.
 *
 * The last two matter because the dock is the only way to reach them: turning
 * the plugin off while either exists would take the user's own timeline data
 * with it.
 *
 * @returns True when no bindings, dock sources, or timespan overlays remain.
 */
export function isTimeSliderIdle(): boolean {
  for (const layer of useAppStore.getState().layers) {
    if (getLayerTimeBinding(layer)) return false;
    if (layer.metadata?.sourceKind === TIME_SLIDER_SOURCE_KIND) return false;
    const span = layer.metadata?.timeSpan as { begin?: unknown } | undefined;
    if (span && typeof span.begin === "number") return false;
  }
  return true;
}
