/**
 * Pure legend construction for the Print Layout composer. Kept free of DOM and
 * PDF dependencies so it can be unit tested directly.
 */
import {
  styleValue,
  type GeoLibreLayer,
  type LayerType,
  type LegendConfig,
  type LegendItemOverride,
  type VectorStyleStop,
} from "@geolibre/core";
import type { LegendEntry, LegendSwatch } from "./print-layout";

/** Layer types styled as vectors (colored fills the legend can represent). */
const VECTOR_TYPES: ReadonlySet<LayerType> = new Set<LayerType>([
  "geojson",
  "flatgeobuf",
  "geoparquet",
  "vector-tiles",
  "pmtiles",
  "duckdb-query",
  "deckgl-viz",
]);

/** Layer types with no meaningful single-swatch legend representation. */
const NON_LEGEND_TYPES: ReadonlySet<LayerType> = new Set<LayerType>([
  "lidar",
  "gaussian-splat",
  "3d-tiles",
  "video",
]);

const NEUTRAL_SWATCH = "#94a3b8";
const MAX_RAMP_SWATCHES = 6;

/**
 * Build legend entries from the visible layers. Vector layers contribute a
 * colored swatch (or several, for graduated/categorized symbology); raster and
 * service layers contribute a single neutral swatch; 3D and media layers are
 * omitted.
 *
 * @param layers - All layers from the store, in render order (bottom first).
 * @returns Legend entries in top-of-stack-first order.
 */
export function buildLegend(layers: GeoLibreLayer[]): LegendEntry[] {
  const entries: LegendEntry[] = [];
  // Render order in the store is bottom-first; legends read top-first.
  for (const layer of [...layers].reverse()) {
    if (!layer.visible) continue;
    if (NON_LEGEND_TYPES.has(layer.type)) continue;

    // MBTiles can carry vector or raster tiles; the app renders it as vector
    // unless its metadata or source says raster (mirrors layer-sync), so a
    // missing or legacy tileType is treated as vector here too.
    const isVector =
      VECTOR_TYPES.has(layer.type) ||
      (layer.type === "mbtiles" &&
        layer.metadata.tileType !== "raster" &&
        layer.source.type !== "raster");
    if (isVector) {
      const mode = styleValue(layer.style, "vectorStyleMode");
      const stops = styleValue(layer.style, "vectorStyleStops");
      if (
        (mode === "graduated" || mode === "categorized") &&
        Array.isArray(stops) &&
        stops.length > 0
      ) {
        entries.push({
          id: layer.id,
          name: layer.name,
          swatches: rampSwatches(stops, mode),
        });
        continue;
      }
      entries.push({
        id: layer.id,
        name: layer.name,
        swatches: [{ color: styleValue(layer.style, "fillColor") }],
      });
      continue;
    }

    // Raster / service layers: a single neutral marker swatch.
    entries.push({
      id: layer.id,
      name: layer.name,
      swatches: [{ color: NEUTRAL_SWATCH }],
    });
  }
  return entries;
}

/** Stable key for an individual class swatch within an entry. */
function swatchKey(layerId: string, index: number): string {
  return `${layerId}::${index}`;
}

/**
 * The label to render for an item: the override trimmed of surrounding
 * whitespace when it has visible content, otherwise the fallback. Trimming here
 * (rather than when storing) keeps the editor input free to accept spaces while
 * the canvas export never shows stray leading/trailing whitespace.
 */
function renderedLabel(label: string | undefined, fallback: string): string {
  const trimmed = label?.trim();
  return trimmed ? trimmed : fallback;
}

/**
 * Whether an override carries a non-blank label. Mirrors {@link renderedLabel}'s
 * blank test so the editor and the rendered legend agree on when an override is
 * in effect.
 */
function hasLabelOverride(label: string | undefined): boolean {
  return label !== undefined && label.trim() !== "";
}

/**
 * Reorder base legend entries to follow {@link LegendConfig.order} (top-first).
 * Layers absent from `order` keep their default position after the listed ones.
 */
function orderEntries(
  entries: LegendEntry[],
  order: string[],
): LegendEntry[] {
  if (order.length === 0) return entries;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const ordered: LegendEntry[] = [];
  for (const id of order) {
    const entry = byId.get(id);
    if (entry && !seen.has(id)) {
      ordered.push(entry);
      seen.add(id);
    }
  }
  for (const entry of entries) {
    if (!seen.has(entry.id)) ordered.push(entry);
  }
  return ordered;
}

/**
 * Apply a user {@link LegendConfig} to the auto-built legend, producing the
 * final entries to render: ordered, with renamed labels and hidden items
 * removed. Entries whose every swatch is hidden are dropped entirely.
 *
 * @param base - Auto-generated entries from {@link buildLegend}.
 * @param config - User customizations from the project.
 * @returns Render-ready legend entries.
 */
export function applyLegendConfig(
  base: LegendEntry[],
  config: LegendConfig,
): LegendEntry[] {
  const ordered = orderEntries(base, config.order);
  const result: LegendEntry[] = [];
  for (const entry of ordered) {
    const entryOverride = config.overrides[entry.id];
    if (entryOverride?.hidden) continue;
    const name = renderedLabel(entryOverride?.label, entry.name);

    if (entry.swatches.length <= 1) {
      result.push({ id: entry.id, name, swatches: entry.swatches });
      continue;
    }

    const swatches: LegendSwatch[] = [];
    entry.swatches.forEach((swatch, index) => {
      const override = config.overrides[swatchKey(entry.id, index)];
      if (override?.hidden) return;
      swatches.push({
        color: swatch.color,
        label: hasLabelOverride(override?.label)
          ? renderedLabel(override?.label, swatch.label ?? "")
          : swatch.label,
      });
    });
    // Every class hidden: drop the whole entry rather than render an empty box.
    if (swatches.length === 0) continue;
    result.push({ id: entry.id, name, swatches });
  }
  return result;
}

/**
 * Return a copy of `config` with `key`'s override replaced by `next`, pruning
 * the entry when it carries neither a label nor a hidden flag so the persisted
 * config stays minimal.
 */
function withOverride(
  config: LegendConfig,
  key: string,
  next: LegendItemOverride,
): LegendConfig {
  const overrides = { ...config.overrides };
  if (next.label === undefined && !next.hidden) {
    delete overrides[key];
  } else {
    overrides[key] = next;
  }
  return { ...config, overrides };
}

/**
 * Set (or clear) the user label for a legend item. A blank label or one equal
 * to the auto-generated default clears the override so the default flows through
 * later (e.g. after the source layer is renamed).
 */
export function setLegendItemLabel(
  config: LegendConfig,
  key: string,
  label: string,
  defaultLabel: string,
): LegendConfig {
  const current = config.overrides[key] ?? {};
  const trimmed = label.trim();
  const nextLabel =
    trimmed === "" || trimmed === defaultLabel.trim() ? undefined : label;
  return withOverride(config, key, { ...current, label: nextLabel });
}

/** Toggle whether a legend item is hidden from the rendered legend. */
export function toggleLegendItemHidden(
  config: LegendConfig,
  key: string,
): LegendConfig {
  const current = config.overrides[key] ?? {};
  const hidden = !current.hidden;
  return withOverride(config, key, {
    label: current.label,
    hidden: hidden ? true : undefined,
  });
}

/**
 * Move a top-level entry up or down within the current order. `entryIdsInOrder`
 * is the full ordered list of entry layer ids, so the persisted order stays
 * complete even when the user had not reordered anything before.
 */
export function reorderLegendEntry(
  config: LegendConfig,
  entryIdsInOrder: string[],
  layerId: string,
  direction: "up" | "down",
): LegendConfig {
  const ids = [...entryIdsInOrder];
  const i = ids.indexOf(layerId);
  if (i < 0) return config;
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= ids.length) return config;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return { ...config, order: ids };
}

/** A flattened, editable legend row surfaced in the Print Layout legend editor. */
export interface LegendEditorRow {
  /** Stable override key (layer id for an entry, `${layerId}::${i}` for a class). */
  key: string;
  /** The owning layer's id (shared by an entry and its class rows). */
  layerId: string;
  /** Class rows are indented under their layer entry. */
  kind: "entry" | "class";
  /** Swatch color, when the row has one (entries always do; class rows do too). */
  color?: string;
  /** The auto-generated label. */
  defaultLabel: string;
  /** Effective label after applying any override. */
  label: string;
  /** Whether the row is currently hidden from the rendered legend. */
  hidden: boolean;
  /** True when this row can be moved up/down (top-level entries only). */
  reorderable: boolean;
}

/**
 * Flatten the auto-built legend into editor rows in the user's current order,
 * with overrides applied for display. Hidden rows are included (the editor shows
 * them dimmed) so the user can unhide them.
 *
 * @param base - Auto-generated entries from {@link buildLegend}.
 * @param config - User customizations from the project.
 * @returns One row per legend entry, with class rows following multi-class entries.
 */
export function legendEditorRows(
  base: LegendEntry[],
  config: LegendConfig,
): LegendEditorRow[] {
  const ordered = orderEntries(base, config.order);
  const rows: LegendEditorRow[] = [];
  for (const entry of ordered) {
    const entryOverride = config.overrides[entry.id];
    const single = entry.swatches.length <= 1;
    rows.push({
      key: entry.id,
      layerId: entry.id,
      kind: "entry",
      color: single ? entry.swatches[0]?.color : undefined,
      defaultLabel: entry.name,
      // Show the raw override (so the input can hold spaces mid-edit) but fall
      // back to the default when it is blank, matching what applyLegendConfig
      // renders.
      label: hasLabelOverride(entryOverride?.label)
        ? (entryOverride?.label as string)
        : entry.name,
      hidden: Boolean(entryOverride?.hidden),
      reorderable: true,
    });
    if (single) continue;
    entry.swatches.forEach((swatch, index) => {
      const key = swatchKey(entry.id, index);
      const override = config.overrides[key];
      const defaultLabel = swatch.label ?? "";
      rows.push({
        key,
        layerId: entry.id,
        kind: "class",
        color: swatch.color,
        defaultLabel,
        label: hasLabelOverride(override?.label)
          ? (override?.label as string)
          : defaultLabel,
        hidden: Boolean(override?.hidden),
        reorderable: false,
      });
    });
  }
  return rows;
}

function rampSwatches(
  stops: VectorStyleStop[],
  mode: "graduated" | "categorized",
): { color: string; label: string }[] {
  const limited =
    stops.length > MAX_RAMP_SWATCHES
      ? sampleEvenly(stops, MAX_RAMP_SWATCHES)
      : stops;
  return limited.map((stop) => ({
    color: stop.color,
    label:
      mode === "graduated"
        ? `≥ ${formatStopValue(stop.value)}`
        : formatStopValue(stop.value),
  }));
}

function sampleEvenly<T>(items: T[], count: number): T[] {
  // count <= 1 would divide by zero below; return the available slice instead.
  if (items.length <= count || count <= 1) return items.slice(0, count);
  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    out.push(items[Math.round((i * (items.length - 1)) / (count - 1))]);
  }
  return out;
}

function formatStopValue(value: unknown): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value ?? "");
}
