/**
 * Structured differ for two {@link GeoLibreProject} documents, used to show
 * what changed between autosave snapshots (GeoLibre#2858, "Project snapshot
 * diff").
 *
 * The result is a summary rather than a JSON patch: layers are matched by id
 * and reported as added, removed, moved or changed; per-layer changes are
 * grouped (style, labels, filter, source, other) with truncated before/after
 * previews; embedded GeoJSON is summarized as counts of added, removed and
 * modified features. Everything is pure and synchronous.
 *
 * Embedded GeoJSON can be large, so each feature is hashed at most once per
 * object identity (memoized in a `WeakMap`), and layers whose `geojson`
 * reference is shared between the two projects are skipped outright.
 */
import type { FeatureCollection } from "geojson";
import type { GeoLibreLayer, GeoLibreProject, ProjectPluginState } from "./types";

/** One changed value, with bounded human-readable previews of each side. */
export interface ProjectValueChange {
  /** Dotted key path relative to the section, e.g. `fillColor` or `labels.field`. */
  path: string;
  /** Preview of the earlier value; `undefined` when the key was absent. */
  before?: string;
  /** Preview of the later value; `undefined` when the key is now absent. */
  after?: string;
}

/** Counts of embedded GeoJSON feature changes in one layer. */
export interface FeatureChangeSummary {
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
  /**
   * How features were matched: `"id"` when every feature carries a unique
   * `id`, `"geometry"` when none does (matched by geometry hash), `"mixed"`
   * otherwise.
   */
  matchedBy: "id" | "geometry" | "mixed";
}

/** Changes to one layer between the two projects. */
export interface LayerDiff {
  id: string;
  /** Layer name in the later project (or the earlier one when removed). */
  name: string;
  /** Layer type in the later project (or the earlier one when removed). */
  type: string;
  status: "added" | "removed" | "changed";
  /** Set when the layer was renamed. */
  renamed?: { before: string; after: string };
  /**
   * Set when the layer changed position relative to the layers present in
   * both projects (bottom-to-top indexes in each project's `layers`).
   */
  moved?: { before: number; after: number };
  visibility?: { before: boolean; after: boolean };
  opacity?: { before: number; after: number };
  /** Style keys other than labels. */
  style: ProjectValueChange[];
  /** Label style keys (`style.labels.*`), without the `labels.` prefix. */
  labels: ProjectValueChange[];
  /** `filterExpression` and `quickFilters`. */
  filter: ProjectValueChange[];
  /** `type`, `source.*` and `sourcePath`. */
  source: ProjectValueChange[];
  /** Any other persisted layer field (popup, joins, metadata.*, ...). */
  other: ProjectValueChange[];
  /** Embedded GeoJSON feature changes; absent when the data is unchanged. */
  features?: FeatureChangeSummary;
  /** Feature count for an added or removed layer with embedded GeoJSON. */
  featureCount?: number;
}

/** Changes to one plugin's project state. */
export interface PluginDiff {
  id: string;
  /** `added`/`removed` mean the plugin was activated/deactivated. */
  status: "added" | "removed" | "changed";
  changes: ProjectValueChange[];
}

/** The full structured difference between two projects. */
export interface ProjectDiff {
  layers: {
    added: LayerDiff[];
    removed: LayerDiff[];
    changed: LayerDiff[];
    /** True when any layer present in both projects changed position. */
    reordered: boolean;
  };
  camera: ProjectValueChange[];
  basemap: ProjectValueChange[];
  /** Map projection (`preferences.map.projection`). */
  projection: ProjectValueChange[];
  /** Other project preferences (`preferences.*` minus the projection). */
  preferences: ProjectValueChange[];
  plugins: PluginDiff[];
  /** Plugin manifest URLs added to or removed from the project. */
  pluginManifests: { added: string[]; removed: string[] };
  /** Project name (`name`), `metadata.description` and other metadata keys. */
  metadata: ProjectValueChange[];
  /** Other top-level sections that changed (`legend`, `storymap`, ...). */
  sections: string[];
  /** Total number of reported changes; 0 means the projects are equivalent. */
  changeCount: number;
}

/** Options for {@link diffProjects}. */
export interface ProjectDiffOptions {
  /** Maximum characters of a before/after preview (default 80). */
  maxPreviewLength?: number;
}

const DEFAULT_PREVIEW_LENGTH = 80;
const CAMERA_EPSILON = 1e-6;

/** Layer fields reported in their own group, never under `other`. */
const LAYER_GROUPED_KEYS = new Set([
  "id",
  "name",
  "type",
  "visible",
  "opacity",
  "style",
  "geojson",
  "filterExpression",
  "quickFilters",
  "source",
  "sourcePath",
  // Derived from the layer order on save; reordering is reported separately.
  "beforeId",
]);

/** Top-level project fields reported in their own group, never as a section. */
const PROJECT_GROUPED_KEYS = new Set([
  "id",
  "version",
  "name",
  "mapView",
  "basemapStyleUrl",
  "basemapVisible",
  "basemapOpacity",
  "blankBackgroundColor",
  "primaryRenderer",
  "layers",
  "styles",
  "preferences",
  "plugins",
  "metadata",
  // UI selection, not content.
  "selectedLayerId",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep structural equality for JSON-like values. A key whose value is
 * `undefined` is treated as absent, so an in-memory record compares equal to
 * its JSON round trip.
 *
 * @param a - First value.
 * @param b - Second value.
 * @returns True when the two values are structurally equal.
 */
export function jsonValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonValuesEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    for (const key of Object.keys(a)) {
      if (a[key] === undefined) continue;
      if (!jsonValuesEqual(a[key], b[key])) return false;
    }
    for (const key of Object.keys(b)) {
      if (b[key] !== undefined && a[key] === undefined) return false;
    }
    return true;
  }
  return false;
}

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return isPlainObject(value) && Object.values(value).every((item) => item === undefined);
}

/**
 * Equality for reporting: like {@link jsonValuesEqual}, but an empty array,
 * an empty object, `null` and an absent value are interchangeable, since the
 * save path omits empty sections that an in-memory project still carries.
 */
function sameForReport(a: unknown, b: unknown): boolean {
  return jsonValuesEqual(a, b) || (isBlank(a) && isBlank(b));
}

/**
 * Render a bounded JSON-ish preview of a value without serializing more of it
 * than the preview can show, so a large array or object costs no more than
 * `maxLength` characters of work.
 *
 * @param value - The value to preview.
 * @param maxLength - Maximum preview length; longer output ends with `…`.
 * @returns The preview, or `undefined` for `undefined`.
 */
export function previewValue(
  value: unknown,
  maxLength = DEFAULT_PREVIEW_LENGTH,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
  }
  let out = "";
  let truncated = false;
  const emit = (text: string): boolean => {
    if (out.length + text.length > maxLength) {
      out += text.slice(0, Math.max(0, maxLength - out.length));
      truncated = true;
      return false;
    }
    out += text;
    return true;
  };
  const walk = (v: unknown): boolean => {
    if (v === null || typeof v !== "object") {
      if (typeof v === "number" && !Number.isFinite(v)) return emit("null");
      // A long string can never fit, so quote only the part that could show
      // instead of serializing a nested blob (a data URI, say) in full.
      if (typeof v === "string" && v.length > maxLength) {
        return emit(JSON.stringify(v.slice(0, maxLength)));
      }
      const text = typeof v === "bigint" ? v.toString() : JSON.stringify(v);
      return emit(text ?? "null");
    }
    if (Array.isArray(v)) {
      if (!emit("[")) return false;
      for (let i = 0; i < v.length; i++) {
        if (i > 0 && !emit(",")) return false;
        if (!walk(v[i] === undefined ? null : v[i])) return false;
      }
      return emit("]");
    }
    if (!emit("{")) return false;
    let first = true;
    for (const [key, item] of Object.entries(v as Record<string, unknown>)) {
      if (item === undefined) continue;
      if (!first && !emit(",")) return false;
      first = false;
      if (!emit(`${JSON.stringify(key)}:`)) return false;
      if (!walk(item)) return false;
    }
    return emit("}");
  };
  walk(value);
  if (truncated) out = `${out.slice(0, Math.max(0, maxLength - 1))}…`;
  return out;
}

/**
 * Diff two records key by key. Nested plain objects are descended into up to
 * `depth` levels (paths joined with `.`); arrays and deeper values are
 * compared whole.
 */
function diffRecords(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  options: { prefix?: string; depth?: number; skip?: Set<string>; maxLength: number },
  out: ProjectValueChange[],
): void {
  const a = before ?? {};
  const b = after ?? {};
  const prefix = options.prefix ?? "";
  const depth = options.depth ?? 1;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (options.skip?.has(key)) continue;
    const x = a[key];
    const y = b[key];
    if (sameForReport(x, y)) continue;
    if (depth > 0 && isPlainObject(x) && isPlainObject(y)) {
      diffRecords(
        x,
        y,
        { prefix: `${prefix}${key}.`, depth: depth - 1, maxLength: options.maxLength },
        out,
      );
      continue;
    }
    out.push({
      path: `${prefix}${key}`,
      before: previewValue(x, options.maxLength),
      after: previewValue(y, options.maxLength),
    });
  }
}

// ---------------------------------------------------------------------------
// Feature hashing
// ---------------------------------------------------------------------------

interface FeatureHash {
  /** Hash of the geometry alone. */
  geometry: string;
  /** Hash of geometry + properties (+ any other member). */
  full: string;
}

const featureHashCache = new WeakMap<object, FeatureHash>();

/** cyrb53: a fast, well-distributed 53-bit string hash. */
function hashString(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function hashFeature(feature: unknown): FeatureHash {
  if (typeof feature !== "object" || feature === null) {
    const text = JSON.stringify(feature ?? null);
    const h = hashString(text);
    return { geometry: h, full: h };
  }
  const cached = featureHashCache.get(feature);
  if (cached) return cached;
  const { geometry, properties, id: _id, ...rest } = feature as Record<string, unknown>;
  const geometryHash = hashString(JSON.stringify(geometry ?? null));
  const propertiesHash = hashString(JSON.stringify(properties ?? null), 1);
  const restKeys = Object.keys(rest).filter((key) => key !== "type" && rest[key] !== undefined);
  const restHash = restKeys.length > 0 ? hashString(JSON.stringify(rest), 2) : "";
  const result = { geometry: geometryHash, full: `${geometryHash}:${propertiesHash}:${restHash}` };
  featureHashCache.set(feature, result);
  return result;
}

function featureKey(feature: unknown): string | null {
  if (typeof feature !== "object" || feature === null) return null;
  const id = (feature as { id?: unknown }).id;
  if (typeof id === "string") return `s:${id}`;
  if (typeof id === "number" && Number.isFinite(id)) return `n:${id}`;
  return null;
}

interface IndexedFeatures {
  byId: Map<string, string>;
  /** Geometry hash → full hashes of the id-less features with that geometry. */
  byGeometry: Map<string, string[]>;
  keyed: number;
  unkeyed: number;
}

function indexFeatures(features: readonly unknown[]): IndexedFeatures {
  const byId = new Map<string, string>();
  const byGeometry = new Map<string, string[]>();
  let keyed = 0;
  let unkeyed = 0;
  for (const feature of features) {
    const hash = hashFeature(feature);
    const key = featureKey(feature);
    if (key !== null && !byId.has(key)) {
      byId.set(key, hash.full);
      keyed++;
      continue;
    }
    // No id, or a duplicate id: fall back to geometry matching.
    const list = byGeometry.get(hash.geometry);
    if (list) list.push(hash.full);
    else byGeometry.set(hash.geometry, [hash.full]);
    unkeyed++;
  }
  return { byId, byGeometry, keyed, unkeyed };
}

/**
 * Count the features added, removed and modified between two feature
 * collections. Features are matched by `id` when they carry one; id-less
 * features are matched by geometry hash, so a feature whose properties
 * changed but whose geometry did not counts as modified, while a moved
 * id-less feature counts as one removal plus one addition.
 *
 * @param before - Earlier collection (absent counts as empty).
 * @param after - Later collection (absent counts as empty).
 * @returns The change counts.
 */
export function diffFeatureCollections(
  before: FeatureCollection | null | undefined,
  after: FeatureCollection | null | undefined,
): FeatureChangeSummary {
  const a = indexFeatures(Array.isArray(before?.features) ? before.features : []);
  const b = indexFeatures(Array.isArray(after?.features) ? after.features : []);
  let added = 0;
  let removed = 0;
  let modified = 0;
  let unchanged = 0;

  for (const [key, hash] of a.byId) {
    const other = b.byId.get(key);
    if (other === undefined) removed++;
    else if (other === hash) unchanged++;
    else modified++;
  }
  for (const key of b.byId.keys()) if (!a.byId.has(key)) added++;

  const geometryKeys = new Set([...a.byGeometry.keys(), ...b.byGeometry.keys()]);
  for (const geometry of geometryKeys) {
    const left = a.byGeometry.get(geometry) ?? [];
    const right = b.byGeometry.get(geometry) ?? [];
    // Pair identical features first, then pair the rest as modified.
    const counts = new Map<string, number>();
    for (const full of left) counts.set(full, (counts.get(full) ?? 0) + 1);
    let same = 0;
    for (const full of right) {
      const n = counts.get(full) ?? 0;
      if (n > 0) {
        counts.set(full, n - 1);
        same++;
      }
    }
    const leftRest = left.length - same;
    const rightRest = right.length - same;
    const paired = Math.min(leftRest, rightRest);
    unchanged += same;
    modified += paired;
    removed += leftRest - paired;
    added += rightRest - paired;
  }

  const keyed = a.keyed + b.keyed;
  const unkeyed = a.unkeyed + b.unkeyed;
  const matchedBy = unkeyed === 0 ? "id" : keyed === 0 ? "geometry" : "mixed";
  return { added, removed, modified, unchanged, matchedBy };
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

function effectiveStyle(
  project: GeoLibreProject,
  layer: GeoLibreLayer,
): Record<string, unknown> | undefined {
  const top = project.styles?.[layer.id];
  if (!top) return layer.style as unknown as Record<string, unknown> | undefined;
  return { ...(layer.style ?? {}), ...top } as unknown as Record<string, unknown>;
}

function featureCountOf(layer: GeoLibreLayer): number | undefined {
  return Array.isArray(layer.geojson?.features) ? layer.geojson.features.length : undefined;
}

function emptyLayerDiff(layer: GeoLibreLayer, status: LayerDiff["status"]): LayerDiff {
  return {
    id: layer.id,
    name: layer.name,
    type: layer.type,
    status,
    style: [],
    labels: [],
    filter: [],
    source: [],
    other: [],
  };
}

/**
 * Ids (of layers present in both orders) that moved: everything outside a
 * longest increasing subsequence of their later positions, so dragging one
 * layer reports that layer rather than every layer it passed.
 */
function movedLayerIds(beforeIds: string[], afterIndex: Map<string, number>): Set<string> {
  const common = beforeIds.filter((id) => afterIndex.has(id));
  const seq = common.map((id) => afterIndex.get(id)!);
  // Patience-sorting LIS with predecessor links.
  const tails: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const stable = new Set<string>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) {
    stable.add(common[i]);
  }
  return new Set(common.filter((id) => !stable.has(id)));
}

function diffLayer(
  beforeProject: GeoLibreProject,
  afterProject: GeoLibreProject,
  a: GeoLibreLayer,
  b: GeoLibreLayer,
  maxLength: number,
): LayerDiff {
  const diff = emptyLayerDiff(b, "changed");
  if (a.name !== b.name) diff.renamed = { before: a.name, after: b.name };
  if (Boolean(a.visible) !== Boolean(b.visible)) {
    diff.visibility = { before: Boolean(a.visible), after: Boolean(b.visible) };
  }
  if (!jsonValuesEqual(a.opacity, b.opacity))
    diff.opacity = { before: a.opacity, after: b.opacity };

  const styleA = effectiveStyle(beforeProject, a);
  const styleB = effectiveStyle(afterProject, b);
  if (!jsonValuesEqual(styleA, styleB)) {
    diffRecords(styleA, styleB, { skip: new Set(["labels"]), maxLength }, diff.style);
    const labelsA = styleA?.labels;
    const labelsB = styleB?.labels;
    if (!jsonValuesEqual(labelsA, labelsB)) {
      diffRecords(
        isPlainObject(labelsA) ? labelsA : undefined,
        isPlainObject(labelsB) ? labelsB : undefined,
        { maxLength },
        diff.labels,
      );
    }
  }

  diffRecords(
    { filterExpression: a.filterExpression, quickFilters: a.quickFilters },
    { filterExpression: b.filterExpression, quickFilters: b.quickFilters },
    { depth: 0, maxLength },
    diff.filter,
  );

  if (a.type !== b.type) {
    diff.source.push({ path: "type", before: a.type, after: b.type });
  }
  if (!jsonValuesEqual(a.source, b.source)) {
    diffRecords(a.source, b.source, { prefix: "source.", depth: 0, maxLength }, diff.source);
  }
  if (a.sourcePath !== b.sourcePath) {
    diff.source.push({
      path: "sourcePath",
      before: previewValue(a.sourcePath, maxLength),
      after: previewValue(b.sourcePath, maxLength),
    });
  }

  diffRecords(
    a as unknown as Record<string, unknown>,
    b as unknown as Record<string, unknown>,
    { skip: LAYER_GROUPED_KEYS, depth: 1, maxLength },
    diff.other,
  );

  if (a.geojson !== b.geojson && (a.geojson || b.geojson)) {
    const features = diffFeatureCollections(a.geojson, b.geojson);
    if (features.added || features.removed || features.modified) diff.features = features;
  }
  return diff;
}

function layerHasChanges(diff: LayerDiff): boolean {
  return Boolean(
    diff.renamed ||
    diff.moved ||
    diff.visibility ||
    diff.opacity ||
    diff.features ||
    diff.style.length ||
    diff.labels.length ||
    diff.filter.length ||
    diff.source.length ||
    diff.other.length,
  );
}

function layerChangeCount(diff: LayerDiff): number {
  return (
    (diff.renamed ? 1 : 0) +
    (diff.moved ? 1 : 0) +
    (diff.visibility ? 1 : 0) +
    (diff.opacity ? 1 : 0) +
    (diff.features ? 1 : 0) +
    diff.style.length +
    diff.labels.length +
    diff.filter.length +
    diff.source.length +
    diff.other.length
  );
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

function diffPlugins(
  before: ProjectPluginState | undefined,
  after: ProjectPluginState | undefined,
  maxLength: number,
): { plugins: PluginDiff[]; manifests: { added: string[]; removed: string[] } } {
  const activeA = new Set(before?.activePluginIds ?? []);
  const activeB = new Set(after?.activePluginIds ?? []);
  const settingsA = before?.settings ?? {};
  const settingsB = after?.settings ?? {};
  const positionsA = before?.mapControlPositions ?? {};
  const positionsB = after?.mapControlPositions ?? {};
  const ids = new Set([
    ...activeA,
    ...activeB,
    ...Object.keys(settingsA),
    ...Object.keys(settingsB),
    ...Object.keys(positionsA),
    ...Object.keys(positionsB),
  ]);
  const plugins: PluginDiff[] = [];
  for (const id of [...ids].sort()) {
    const changes: ProjectValueChange[] = [];
    const wasActive = activeA.has(id);
    const isActive = activeB.has(id);
    if (!jsonValuesEqual(positionsA[id], positionsB[id])) {
      changes.push({
        path: "position",
        before: previewValue(positionsA[id], maxLength),
        after: previewValue(positionsB[id], maxLength),
      });
    }
    const sa = settingsA[id];
    const sb = settingsB[id];
    if (!jsonValuesEqual(sa, sb)) {
      if (isPlainObject(sa) || isPlainObject(sb)) {
        diffRecords(
          isPlainObject(sa) ? sa : undefined,
          isPlainObject(sb) ? sb : undefined,
          { prefix: "settings.", depth: 0, maxLength },
          changes,
        );
      } else {
        changes.push({
          path: "settings",
          before: previewValue(sa, maxLength),
          after: previewValue(sb, maxLength),
        });
      }
    }
    if (wasActive !== isActive) {
      plugins.push({ id, status: isActive ? "added" : "removed", changes });
    } else if (changes.length > 0) {
      plugins.push({ id, status: "changed", changes });
    }
  }
  const urlsA = new Set(before?.manifestUrls ?? []);
  const urlsB = new Set(after?.manifestUrls ?? []);
  return {
    plugins,
    manifests: {
      added: [...urlsB].filter((url) => !urlsA.has(url)),
      removed: [...urlsA].filter((url) => !urlsB.has(url)),
    },
  };
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

function numbersDiffer(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) > CAMERA_EPSILON;
  return !jsonValuesEqual(a, b);
}

/**
 * Compute a structured summary of what changed from `before` to `after`.
 *
 * Layers are matched by id. Embedded GeoJSON is compared per feature (by id,
 * falling back to geometry hash) and each feature is hashed once per object,
 * so diffing the same parsed project against several others reuses its
 * hashes; callers keep and pass the same parsed project objects to benefit.
 *
 * @param before - The earlier project (e.g. an autosave snapshot).
 * @param after - The later project (e.g. the current project).
 * @param options - Preview length and other tuning.
 * @returns The grouped change summary.
 */
export function diffProjects(
  before: GeoLibreProject,
  after: GeoLibreProject,
  options: ProjectDiffOptions = {},
): ProjectDiff {
  const maxLength = options.maxPreviewLength ?? DEFAULT_PREVIEW_LENGTH;
  const layersA = Array.isArray(before.layers) ? before.layers : [];
  const layersB = Array.isArray(after.layers) ? after.layers : [];
  const byIdA = new Map(layersA.map((layer) => [layer.id, layer]));
  const byIdB = new Map(layersB.map((layer) => [layer.id, layer]));
  const indexA = new Map(layersA.map((layer, i) => [layer.id, i]));
  const indexB = new Map(layersB.map((layer, i) => [layer.id, i]));
  const moved = movedLayerIds(
    layersA.map((layer) => layer.id),
    indexB,
  );

  const added: LayerDiff[] = [];
  const removed: LayerDiff[] = [];
  const changed: LayerDiff[] = [];
  for (const layer of layersB) {
    if (byIdA.has(layer.id)) continue;
    const diff = emptyLayerDiff(layer, "added");
    const count = featureCountOf(layer);
    if (count !== undefined) diff.featureCount = count;
    added.push(diff);
  }
  for (const layer of layersA) {
    if (byIdB.has(layer.id)) continue;
    const diff = emptyLayerDiff(layer, "removed");
    const count = featureCountOf(layer);
    if (count !== undefined) diff.featureCount = count;
    removed.push(diff);
  }
  // Report changed layers top-most first, matching the Layers panel.
  for (let i = layersB.length - 1; i >= 0; i--) {
    const b = layersB[i];
    const a = byIdA.get(b.id);
    if (!a) continue;
    const identical = a === b && before.styles?.[b.id] === after.styles?.[b.id];
    const diff = identical
      ? emptyLayerDiff(b, "changed")
      : diffLayer(before, after, a, b, maxLength);
    if (moved.has(b.id)) diff.moved = { before: indexA.get(b.id)!, after: indexB.get(b.id)! };
    if (layerHasChanges(diff)) changed.push(diff);
  }

  const camera: ProjectValueChange[] = [];
  const viewA = before.mapView ?? ({} as GeoLibreProject["mapView"]);
  const viewB = after.mapView ?? ({} as GeoLibreProject["mapView"]);
  const centerA = viewA.center ?? [];
  const centerB = viewB.center ?? [];
  if (numbersDiffer(centerA[0], centerB[0]) || numbersDiffer(centerA[1], centerB[1])) {
    const fmt = (c: unknown[]) =>
      c.length === 2 && c.every((n) => typeof n === "number")
        ? `${(c[0] as number).toFixed(5)}, ${(c[1] as number).toFixed(5)}`
        : undefined;
    camera.push({ path: "center", before: fmt(centerA), after: fmt(centerB) });
  }
  for (const key of ["zoom", "bearing", "pitch"] as const) {
    if (numbersDiffer(viewA[key], viewB[key])) {
      const fmt = (n: unknown) =>
        typeof n === "number" ? String(Math.round(n * 100) / 100) : previewValue(n, maxLength);
      camera.push({ path: key, before: fmt(viewA[key]), after: fmt(viewB[key]) });
    }
  }

  const basemap: ProjectValueChange[] = [];
  diffRecords(
    {
      basemapStyleUrl: before.basemapStyleUrl,
      basemapVisible: before.basemapVisible,
      basemapOpacity: before.basemapOpacity,
      blankBackgroundColor: before.blankBackgroundColor ?? undefined,
      primaryRenderer: before.primaryRenderer,
    },
    {
      basemapStyleUrl: after.basemapStyleUrl,
      basemapVisible: after.basemapVisible,
      basemapOpacity: after.basemapOpacity,
      blankBackgroundColor: after.blankBackgroundColor ?? undefined,
      primaryRenderer: after.primaryRenderer,
    },
    { depth: 0, maxLength: Math.max(maxLength, 160) },
    basemap,
  );

  const projection: ProjectValueChange[] = [];
  const prefsA = (before.preferences ?? {}) as unknown as Record<string, unknown>;
  const prefsB = (after.preferences ?? {}) as unknown as Record<string, unknown>;
  const mapA = isPlainObject(prefsA.map) ? prefsA.map : {};
  const mapB = isPlainObject(prefsB.map) ? prefsB.map : {};
  if (!jsonValuesEqual(mapA.projection, mapB.projection)) {
    projection.push({
      path: "projection",
      before: previewValue(mapA.projection, maxLength),
      after: previewValue(mapB.projection, maxLength),
    });
  }
  const preferences: ProjectValueChange[] = [];
  if (!jsonValuesEqual(prefsA, prefsB)) {
    diffRecords(
      { ...prefsA, map: { ...mapA, projection: undefined } },
      { ...prefsB, map: { ...mapB, projection: undefined } },
      { depth: 1, maxLength },
      preferences,
    );
  }

  const { plugins, manifests } = diffPlugins(before.plugins, after.plugins, maxLength);

  const metadata: ProjectValueChange[] = [];
  if (before.name !== after.name) {
    metadata.push({
      path: "name",
      before: previewValue(before.name, maxLength),
      after: previewValue(after.name, maxLength),
    });
  }
  diffRecords(before.metadata, after.metadata, { depth: 0, maxLength }, metadata);
  // Lead with the description, the field users edit, ahead of other keys.
  metadata.sort((x, y) => metadataRank(x.path) - metadataRank(y.path));

  const sections: string[] = [];
  const projectA = before as unknown as Record<string, unknown>;
  const projectB = after as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(projectA), ...Object.keys(projectB)])) {
    if (PROJECT_GROUPED_KEYS.has(key)) continue;
    if (!sameForReport(projectA[key], projectB[key])) sections.push(key);
  }
  sections.sort();

  const changeCount =
    added.length +
    removed.length +
    changed.reduce((sum, diff) => sum + layerChangeCount(diff), 0) +
    camera.length +
    basemap.length +
    projection.length +
    preferences.length +
    // A plugin counts each changed setting, like a layer counts each key; a
    // bare enable/disable counts once.
    plugins.reduce((sum, plugin) => sum + Math.max(1, plugin.changes.length), 0) +
    manifests.added.length +
    manifests.removed.length +
    metadata.length +
    sections.length;

  return {
    layers: { added, removed, changed, reordered: moved.size > 0 },
    camera,
    basemap,
    projection,
    preferences,
    plugins,
    pluginManifests: manifests,
    metadata,
    sections,
    changeCount,
  };
}

function metadataRank(path: string): number {
  if (path === "name") return 0;
  if (path === "description") return 1;
  return 2;
}
