// The Style Manager's data layer (issue #1294): subset extraction, untrusted
// input normalization, the shareable JSON bundle format, and the built-in
// presets. UI-free so both the desktop app and tests consume it directly.

import {
  DEFAULT_LAYER_STYLE,
  type LabelStyle,
  type LayerStyle,
  type LayerType,
  type StyleLibraryEntry,
  type StyleLibraryEntryKind,
} from "./types";

/**
 * Layer types whose symbology is driven by the vector {@link LayerStyle}
 * fields and can therefore receive a Style Manager entry (or a style-file
 * import). The single source of truth for every entry point — the Style
 * Manager dialog, the Style panel header button, and the layer context menu —
 * so a future vector-stylable type cannot be added to one gate and missed in
 * another, leaving a dead-end entry point.
 */
export function isStyleLibraryTargetLayer(type: LayerType): boolean {
  return type === "geojson" || type === "vector-tiles";
}

/** `type` discriminator of an exported Style Manager bundle file. */
export const STYLE_LIBRARY_BUNDLE_TYPE = "geolibre-style-library";

/** Current bundle format version, for forward-compatible readers. */
export const STYLE_LIBRARY_BUNDLE_VERSION = 1;

const STYLE_LIBRARY_ENTRY_KINDS: readonly StyleLibraryEntryKind[] = [
  "style",
  "symbol",
  "labels",
  "ramp",
];

/**
 * The {@link LayerStyle} keys a `"symbol"` entry captures: fill, stroke,
 * point/circle, marker, and fill-pattern symbology. Deliberately excludes the
 * renderer configuration (`vector*`), labels, zoom range, and raster
 * adjustments so a symbol preset restyles a layer without dismantling its
 * classification or labeling.
 */
export const SYMBOL_STYLE_KEYS = [
  "fillColor",
  "strokeColor",
  "strokeWidth",
  "strokeWidthUnit",
  "fillOpacity",
  "circleRadius",
  "fillPattern",
  "fillPatternColor",
  "fillPatternSvg",
  "markerEnabled",
  "markerShape",
  "markerColor",
  "markerSize",
  "markerSvg",
] as const satisfies readonly (keyof LayerStyle)[];

/**
 * The {@link LayerStyle} keys a `"ramp"` entry captures. The classified
 * attribute (`vectorStyleProperty`) and the concrete stops are deliberately
 * excluded: they are data-specific, so a ramp preset stays reusable across
 * layers with different attributes and value ranges.
 */
export const RAMP_STYLE_KEYS = [
  "vectorStyleColorRamp",
  "vectorStyleClassCount",
  "vectorStyleClassificationScheme",
] as const satisfies readonly (keyof LayerStyle)[];

/**
 * Extract the {@link LayerStyle} subset a Style Manager entry of `kind`
 * stores, deep-cloned so later edits to the live layer cannot mutate the
 * saved entry.
 *
 * @param style - The source layer's full style.
 * @param kind - Which subset to capture.
 * @returns The cloned subset to store in a {@link StyleLibraryEntry}.
 */
export function extractStyleLibraryStyle(
  style: LayerStyle,
  kind: StyleLibraryEntryKind,
): Partial<LayerStyle> {
  if (kind === "labels") {
    return structuredClone({ labels: style.labels ?? DEFAULT_LAYER_STYLE.labels });
  }
  if (kind === "symbol" || kind === "ramp") {
    const keys: readonly (keyof LayerStyle)[] =
      kind === "symbol" ? SYMBOL_STYLE_KEYS : RAMP_STYLE_KEYS;
    const subset: Partial<LayerStyle> = {};
    for (const key of keys) {
      const value = style[key] ?? DEFAULT_LAYER_STYLE[key];
      (subset as Record<string, unknown>)[key] = value;
    }
    return structuredClone(subset);
  }
  return structuredClone({ ...DEFAULT_LAYER_STYLE, ...style });
}

/**
 * Allowed values for the enum-typed {@link LayerStyle} fields, so a
 * hand-edited file cannot smuggle an unknown mode/shape/unit string through
 * the primitive `typeof` check and into the renderer. Fields absent here are
 * free-form strings (colors, expressions, property names, SVG markup).
 */
const STYLE_ENUM_VALUES: Partial<Record<keyof LayerStyle, readonly string[]>> = {
  strokeWidthUnit: ["pixels", "meters"],
  vectorStyleMode: ["single", "graduated", "categorized", "rule-based", "expression"],
  fillPattern: ["none", "hatch", "cross-hatch", "horizontal", "vertical", "dots", "svg"],
  markerShape: ["circle", "square", "triangle", "diamond", "star", "cross", "pin", "custom"],
  pointRenderer: ["single", "heatmap", "cluster"],
  // Union of the graduated and categorized schemes the Style panel offers.
  vectorStyleClassificationScheme: [
    "equal-interval",
    "quantile",
    "natural-breaks",
    "top-values",
    "alphabetical",
    "first-values",
  ],
};

/** Allowed values for the enum-typed {@link LabelStyle} fields. */
const LABEL_ENUM_VALUES: Partial<Record<keyof LabelStyle, readonly string[]>> = {
  placement: ["point", "line"],
  anchor: [
    "center",
    "left",
    "right",
    "top",
    "bottom",
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
  ],
  transform: ["none", "uppercase", "lowercase"],
  dedupe: ["off", "unique", "concatenate"],
};

/**
 * Coerce an untrusted style patch (from a hand-edited project file or an
 * imported bundle) into a safe {@link LayerStyle} subset: unknown keys are
 * dropped, values whose primitive type disagrees with the default (or that
 * are non-finite numbers, or strings outside an enum field's allowed set) are
 * dropped, and a present `labels` object is completed against the default
 * label style so applying it never leaves the renderer reading undefined
 * label fields.
 *
 * @param value - The raw `style` value from JSON.
 * @returns The sanitized subset (empty when nothing usable survives).
 */
export function sanitizeLayerStylePatch(value: unknown): Partial<LayerStyle> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_LAYER_STYLE) as (keyof LayerStyle)[]) {
    if (!(key in source)) continue;
    const given = source[key];
    const fallback = DEFAULT_LAYER_STYLE[key];
    if (key === "labels") {
      if (given && typeof given === "object" && !Array.isArray(given)) {
        const givenLabels = given as Record<string, unknown>;
        const labels: Record<string, unknown> = {};
        for (const labelKey of Object.keys(DEFAULT_LAYER_STYLE.labels) as (keyof LabelStyle)[]) {
          const labelFallback = DEFAULT_LAYER_STYLE.labels[labelKey];
          const labelGiven = givenLabels[labelKey];
          const labelAllowed = LABEL_ENUM_VALUES[labelKey];
          const labelValid =
            typeof labelGiven === typeof labelFallback &&
            (typeof labelGiven !== "number" || Number.isFinite(labelGiven)) &&
            (!labelAllowed || labelAllowed.includes(labelGiven as string));
          labels[labelKey] = labelValid ? labelGiven : labelFallback;
        }
        out.labels = labels as unknown as LabelStyle;
      }
      continue;
    }
    if (Array.isArray(fallback)) {
      if (!Array.isArray(given)) continue;
      // Validate array elements too, not just "is an array": malformed stop
      // or rule objects would otherwise survive to the renderer. Rebuild each
      // element from its known fields so extra keys are stripped along the
      // way; an invalid optional label is dropped rather than the whole stop.
      if (key === "vectorStyleStops") {
        out[key] = given.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const stop = item as Record<string, unknown>;
          if (
            (typeof stop.value !== "string" &&
              !(typeof stop.value === "number" && Number.isFinite(stop.value))) ||
            typeof stop.color !== "string"
          ) {
            return [];
          }
          return [
            {
              value: stop.value,
              color: stop.color,
              ...(typeof stop.label === "string" ? { label: stop.label } : {}),
            },
          ];
        });
      } else if (key === "vectorRules") {
        out[key] = given.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const rule = item as Record<string, unknown>;
          if (
            typeof rule.id !== "string" ||
            typeof rule.label !== "string" ||
            typeof rule.filter !== "string" ||
            typeof rule.color !== "string" ||
            typeof rule.isElse !== "boolean"
          ) {
            return [];
          }
          // Optional per-rule fields (enabled toggle, zoom range, nesting,
          // symbol overrides) carry through only when well-typed; a malformed
          // optional field is dropped rather than the whole rule.
          const optionalNumber = (value: unknown) =>
            typeof value === "number" && Number.isFinite(value) ? value : undefined;
          // Out-of-domain numbers are dropped (the rule inherits the layer
          // value) rather than clamped, so a nonsense hand-edited value never
          // silently becomes a different-but-valid override.
          const optionalInRange = (value: unknown, min: number, max: number) => {
            const parsed = optionalNumber(value);
            return parsed !== undefined && parsed >= min && parsed <= max ? parsed : undefined;
          };
          const optionalString = (value: unknown) =>
            typeof value === "string" ? value : undefined;
          const minZoom = optionalInRange(rule.minZoom, 0, 24);
          const maxZoom = optionalInRange(rule.maxZoom, 0, 24);
          const parentId = optionalString(rule.parentId);
          const strokeColor = optionalString(rule.strokeColor);
          const strokeWidth = optionalInRange(rule.strokeWidth, 0, Number.POSITIVE_INFINITY);
          const fillOpacity = optionalInRange(rule.fillOpacity, 0, 1);
          const circleRadius = optionalInRange(rule.circleRadius, 0, Number.POSITIVE_INFINITY);
          return [
            {
              id: rule.id,
              label: rule.label,
              filter: rule.filter,
              color: rule.color,
              isElse: rule.isElse,
              ...(rule.enabled === false ? { enabled: false } : {}),
              ...(minZoom !== undefined ? { minZoom } : {}),
              ...(maxZoom !== undefined ? { maxZoom } : {}),
              ...(parentId !== undefined ? { parentId } : {}),
              ...(strokeColor !== undefined ? { strokeColor } : {}),
              ...(strokeWidth !== undefined ? { strokeWidth } : {}),
              ...(fillOpacity !== undefined ? { fillOpacity } : {}),
              ...(circleRadius !== undefined ? { circleRadius } : {}),
            },
          ];
        });
      } else {
        out[key] = given;
      }
      continue;
    }
    if (typeof given !== typeof fallback) continue;
    if (typeof given === "number" && !Number.isFinite(given)) continue;
    const allowed = STYLE_ENUM_VALUES[key];
    if (allowed && !allowed.includes(given as string)) continue;
    out[key] = given;
  }
  return structuredClone(out) as Partial<LayerStyle>;
}

/**
 * Restrict a sanitized style patch to the key set its entry `kind` declares,
 * mirroring what {@link extractStyleLibraryStyle} captures on save. Without
 * this, a hand-edited project file or imported bundle could declare
 * `kind: "symbol"` with extra full-style fields in the payload, and applying
 * that "Symbol only" entry (a partial merge) would silently change labels or
 * renderer settings on the target layer.
 */
function restrictStylePatchToKind(
  style: Partial<LayerStyle>,
  kind: StyleLibraryEntryKind,
): Partial<LayerStyle> {
  if (kind === "style") return style;
  const allowed: readonly (keyof LayerStyle)[] =
    kind === "symbol" ? SYMBOL_STYLE_KEYS : kind === "ramp" ? RAMP_STYLE_KEYS : ["labels"];
  const out: Partial<LayerStyle> = {};
  for (const key of allowed) {
    if (key in style) {
      (out as Record<string, unknown>)[key] = style[key];
    }
  }
  return out;
}

/**
 * Coerce an untrusted (hand-edited project file or imported bundle) entries
 * array into valid {@link StyleLibraryEntry} records. Drops entries without a
 * usable id or name, de-duplicates by id, coerces an unknown kind to
 * `"style"`, and sanitizes each style payload (restricted to the declared
 * kind's key set); entries whose payload sanitizes to nothing are dropped.
 *
 * @param value - The raw `styleLibrary` / bundle `entries` value.
 * @returns Normalized, de-duplicated entries (empty when none survive).
 */
export function normalizeStyleLibraryEntries(value: unknown): StyleLibraryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: StyleLibraryEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Partial<StyleLibraryEntry>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    const kind = STYLE_LIBRARY_ENTRY_KINDS.includes(candidate.kind as StyleLibraryEntryKind)
      ? (candidate.kind as StyleLibraryEntryKind)
      : "style";
    const style = restrictStylePatchToKind(sanitizeLayerStylePatch(candidate.style), kind);
    if (Object.keys(style).length === 0) continue;
    seen.add(id);
    const tags = Array.isArray(candidate.tags)
      ? [
          ...new Set(
            candidate.tags
              .filter((tag): tag is string => typeof tag === "string")
              .map((tag) => tag.trim())
              .filter((tag) => tag !== ""),
          ),
        ]
      : [];
    entries.push({
      id,
      name,
      kind,
      tags,
      style,
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : "",
    });
  }
  return entries;
}

/**
 * Serialize Style Manager entries into the shareable bundle JSON written by
 * the Export action and read back by {@link parseStyleLibrary}.
 *
 * @param entries - The entries to export.
 * @returns Pretty-printed bundle JSON.
 */
export function serializeStyleLibrary(entries: StyleLibraryEntry[]): string {
  return JSON.stringify(
    {
      type: STYLE_LIBRARY_BUNDLE_TYPE,
      version: STYLE_LIBRARY_BUNDLE_VERSION,
      entries,
    },
    null,
    2,
  );
}

/**
 * Parse a Style Manager bundle produced by {@link serializeStyleLibrary} (a
 * bare entries array is also accepted, so hand-authored files work). Entries
 * are normalized through {@link normalizeStyleLibraryEntries}.
 *
 * @param json - The bundle file content.
 * @returns The normalized entries.
 * @throws Error when the JSON is not a style-library bundle or holds no
 *   usable entries.
 */
export function parseStyleLibrary(json: string): StyleLibraryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Not a valid style library file (invalid JSON).");
  }
  let rawEntries: unknown = null;
  if (Array.isArray(parsed)) {
    rawEntries = parsed;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    (parsed as { type?: unknown }).type === STYLE_LIBRARY_BUNDLE_TYPE
  ) {
    // Refuse bundles from a newer format rather than misreading them with v1
    // semantics (e.g. coercing kinds this version does not know to "style").
    // Bare arrays stay accepted for hand-authored files.
    if ((parsed as { version?: unknown }).version !== STYLE_LIBRARY_BUNDLE_VERSION) {
      throw new Error("Unsupported style library version.");
    }
    rawEntries = (parsed as { entries?: unknown }).entries;
  }
  if (rawEntries === null) {
    throw new Error("Not a valid style library file.");
  }
  const entries = normalizeStyleLibraryEntries(rawEntries);
  if (entries.length === 0) {
    throw new Error("The style library file holds no usable entries.");
  }
  return entries;
}

/**
 * Create a fresh unique id for a new library entry.
 *
 * @returns A random id (UUID when available).
 */
export function createStyleLibraryEntryId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `style-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Built-in presets shown in the Style Manager so the library is not empty on
 * first open (issue #1294). Read-only: they are not persisted, cannot be
 * deleted, and their ids are namespaced with `preset-` so user entries never
 * collide. Names are plain English by the same convention as the ramp labels
 * in `color-ramp.ts`.
 */
export const BUILT_IN_STYLE_PRESETS: readonly StyleLibraryEntry[] = [
  {
    id: "preset-boundary-outline",
    name: "Boundary outline",
    kind: "symbol",
    tags: ["boundary", "basemap"],
    style: {
      fillColor: "#4b5563",
      fillOpacity: 0,
      strokeColor: "#4b5563",
      strokeWidth: 1.5,
      strokeWidthUnit: "pixels",
      fillPattern: "none",
    },
    updatedAt: "",
  },
  {
    id: "preset-boundary-bold",
    name: "Boundary outline (bold)",
    kind: "symbol",
    tags: ["boundary", "basemap"],
    style: {
      fillColor: "#111827",
      fillOpacity: 0,
      strokeColor: "#111827",
      strokeWidth: 2.5,
      strokeWidthUnit: "pixels",
      fillPattern: "none",
    },
    updatedAt: "",
  },
  {
    id: "preset-muted-polygon",
    name: "Muted polygon",
    kind: "symbol",
    tags: ["basemap", "polygon"],
    style: {
      fillColor: "#e5e7eb",
      fillOpacity: 0.35,
      strokeColor: "#9ca3af",
      strokeWidth: 1,
      fillPattern: "none",
    },
    updatedAt: "",
  },
  {
    id: "preset-highlight",
    name: "Highlight",
    kind: "symbol",
    tags: ["polygon", "selection"],
    style: {
      fillColor: "#facc15",
      fillOpacity: 0.45,
      strokeColor: "#d97706",
      strokeWidth: 2,
      fillPattern: "none",
    },
    updatedAt: "",
  },
  {
    id: "preset-water",
    name: "Water",
    kind: "symbol",
    tags: ["polygon", "hydrology"],
    style: {
      fillColor: "#60a5fa",
      fillOpacity: 0.5,
      strokeColor: "#2563eb",
      strokeWidth: 1,
      fillPattern: "none",
    },
    updatedAt: "",
  },
  {
    id: "preset-marker-pin",
    name: "Pin marker",
    kind: "symbol",
    tags: ["point", "marker"],
    style: {
      markerEnabled: true,
      markerShape: "pin",
      markerColor: "#dc2626",
      markerSize: 22,
      circleRadius: 6,
      fillColor: "#dc2626",
    },
    updatedAt: "",
  },
  {
    id: "preset-labels-dark",
    name: "Labels (dark on light halo)",
    kind: "labels",
    tags: ["labels"],
    style: {
      labels: {
        ...DEFAULT_LAYER_STYLE.labels,
        enabled: true,
        size: 12,
        color: "#111827",
        haloColor: "#ffffff",
        haloWidth: 1.5,
      },
    },
    updatedAt: "",
  },
  {
    id: "preset-ramp-viridis-5",
    name: "Viridis (5 classes, quantile)",
    kind: "ramp",
    tags: ["ramp"],
    style: {
      vectorStyleColorRamp: "viridis",
      vectorStyleClassCount: 5,
      vectorStyleClassificationScheme: "quantile",
    },
    updatedAt: "",
  },
  {
    id: "preset-ramp-blues-5",
    name: "Blues (5 classes, equal interval)",
    kind: "ramp",
    tags: ["ramp"],
    style: {
      vectorStyleColorRamp: "blues",
      vectorStyleClassCount: 5,
      vectorStyleClassificationScheme: "equal-interval",
    },
    updatedAt: "",
  },
  {
    id: "preset-ramp-spectral-7",
    name: "Spectral (7 classes, quantile)",
    kind: "ramp",
    tags: ["ramp"],
    style: {
      vectorStyleColorRamp: "spectral",
      vectorStyleClassCount: 7,
      vectorStyleClassificationScheme: "quantile",
    },
    updatedAt: "",
  },
];
