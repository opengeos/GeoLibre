/**
 * Pure helpers for the popup and tooltip designer (#2113): resolving which
 * fields a layer's Identify popup (or hover tooltip) shows and in what order,
 * and formatting each value the way the author asked for.
 *
 * The designer UI (Style panel → Popup) authors a {@link LayerPopupConfig} on
 * the layer; `MapCanvas` renders the popup from these helpers so the click
 * popup and the hover tooltip agree on labels, order and formatting.
 * Everything here is side-effect free so it can be unit tested without a DOM
 * or the app store.
 *
 * Two rules the rest of the app depends on:
 *
 * - {@link GeoLibreLayer.fieldVisibility} is authoritative. A field marked
 *   `"hidden"` or `"excluded"` never reaches a popup, even when a popup config
 *   names it explicitly — the config selects from what is visible, it cannot
 *   re-expose what the author hid.
 * - A layer with no config behaves exactly as it did before the designer
 *   existed: every property, in the feature's own key order, unformatted.
 */
import type { Feature } from "geojson";
import { compileFeatureExpression, type CompiledFeatureExpression } from "./expressions";
import { PHOTO_FULL_PROPERTY } from "./photo";
import type {
  FieldVisibility,
  LayerPopupConfig,
  PopupDateFormat,
  PopupFieldConfig,
  PopupFieldFormat,
  PopupFieldKind,
} from "./types";

/** Match an inline base64 raster image (excludes SVG, which can carry scripts). */
const INLINE_IMAGE_DATA_URL = /^data:image\/(?!svg)[\w.+-]+;base64,/i;

/** One resolved popup row, ready for the renderer. */
export interface PopupRow {
  /** Feature property key. */
  field: string;
  /** Label to print in the key column. */
  label: string;
  /** The raw property value, for kinds that need it (image `src`, link `href`). */
  value: unknown;
  /** The formatted value text. */
  text: string;
  /** How the renderer should draw the value. */
  kind: PopupFieldKind;
  /** Link text for a `"link"` row; falls back to the value. */
  linkLabel?: string;
}

/**
 * A trimmed non-empty string, or `undefined` for anything else.
 *
 * Popup configs arrive from untrusted JSON — a hand-edited `.geolibre.json`, an
 * imported layer-library bundle, an MCP-authored project — so a field typed as
 * `string` may hold a number, an object or null. `value.trim()` on one of those
 * throws and takes the whole popup render with it, so every string read here
 * goes through this.
 */
function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Whether the Identify popup should open for a layer. Default: yes. */
export function isPopupClickEnabled(popup: LayerPopupConfig | undefined): boolean {
  return popup?.click !== false;
}

/** Whether a hover tooltip should follow the pointer. Default: no. */
export function isPopupHoverEnabled(popup: LayerPopupConfig | undefined): boolean {
  return popup?.hover === true;
}

/** The label a popup shows for a configured field. */
export function popupFieldLabel(config: PopupFieldConfig): string {
  return trimmedString(config.label) ?? config.field;
}

/**
 * Property keys that never belong in a popup: GeoLibre's own internal columns
 * and the full-resolution companion of a photo thumbnail (an internal twin of
 * a value already shown, and often multiple megabytes of data URL).
 */
export function isInternalPopupField(key: string): boolean {
  return key === PHOTO_FULL_PROPERTY || key.startsWith("__geolibre_");
}

/**
 * The property keys a popup may show, before any popup config narrows them:
 * the feature's own keys minus the internal ones and anything the author
 * marked `"hidden"` or `"excluded"`.
 */
export function visiblePopupFields(
  properties: Record<string, unknown>,
  fieldVisibility?: Record<string, FieldVisibility>,
): string[] {
  return Object.keys(properties).filter(
    (key) => !isInternalPopupField(key) && !fieldVisibility?.[key],
  );
}

/** Options for {@link formatPopupValue} and {@link resolvePopupRows}. */
export interface PopupFormatOptions {
  /**
   * BCP 47 tag for number/date formatting. Omitted means the runtime default,
   * which is what the browser uses for every other locale-aware rendering.
   */
  locale?: string;
}

function formatNumber(value: number, format: PopupFieldFormat, locale?: string): string {
  const options: Intl.NumberFormatOptions = {
    useGrouping: format.thousands === true,
  };
  if (format.decimals != null && Number.isFinite(format.decimals)) {
    const digits = Math.max(0, Math.min(20, Math.trunc(format.decimals)));
    options.minimumFractionDigits = digits;
    options.maximumFractionDigits = digits;
  }
  return new Intl.NumberFormat(locale, options).format(value);
}

/**
 * Coerce a property value to a Date. A number is epoch milliseconds (what a
 * GeoJSON timestamp column normally holds); a string goes through `Date`'s own
 * parser. Anything that does not parse comes back as `null` so the caller can
 * fall back to the raw text rather than printing "Invalid Date".
 */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const fromEpoch = new Date(value);
    return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function formatDate(date: Date, dateFormat: PopupDateFormat, locale?: string): string {
  switch (dateFormat) {
    case "datetime":
      return date.toLocaleString(locale);
    case "time":
      return date.toLocaleTimeString(locale);
    case "iso":
      return date.toISOString();
    case "year":
      // Local, like the date/datetime/time cases above — only `iso` is
      // deliberately UTC, because that is what the format itself means. Reading
      // the year in UTC while the neighbouring formats read local would make
      // "Year" disagree with "Date" for the same timestamp near a year
      // boundary (2026-01-01T02:00:00Z is Dec 31 2025 in UTC-8).
      return String(date.getFullYear());
    case "date":
    default:
      return date.toLocaleDateString(locale);
  }
}

/** Stringify a value the way the untyped popup always has. */
export function stringifyPopupValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Render one value as text under a field's kind and format. `"auto"` and
 * `"image"` values are returned verbatim (the renderer draws them itself);
 * every other kind is stringified, formatted, then wrapped in the configured
 * prefix/suffix.
 */
export function formatPopupValue(
  value: unknown,
  config: Pick<PopupFieldConfig, "kind" | "format"> = {},
  options: PopupFormatOptions = {},
): string {
  const kind = config.kind ?? "auto";
  const format = config.format ?? {};
  if (kind === "auto" || kind === "image") return stringifyPopupValue(value);

  // A missing value stays missing under every kind. Without this a `number`
  // field would coerce null (and "") through `Number("")` to a confident 0,
  // reporting a population of zero for a city that simply has no figure.
  if (value == null || (typeof value === "string" && value.trim() === "")) return "";

  let body: string;
  if (kind === "number") {
    const numeric = typeof value === "number" ? value : Number(stringifyPopupValue(value));
    body = Number.isFinite(numeric)
      ? formatNumber(numeric, format, options.locale)
      : stringifyPopupValue(value);
  } else if (kind === "date") {
    const date = toDate(value);
    body = date
      ? formatDate(date, format.dateFormat ?? "date", options.locale)
      : stringifyPopupValue(value);
  } else {
    body = stringifyPopupValue(value);
  }

  // An empty value gets no affixes: "$" alone, or a bare " km", reads as data
  // that is present when it is not.
  if (body === "") return "";
  return `${format.prefix ?? ""}${body}${format.suffix ?? ""}`;
}

/** Whether a row would draw as a picture rather than as text. */
function rendersAsImage(kind: PopupFieldKind, value: unknown): boolean {
  return kind === "image" || (kind === "auto" && isInlineImageValue(value));
}

/**
 * The properties a popup may read, with the author's hidden and excluded
 * fields and GeoLibre's internal columns removed.
 *
 * Expressions get this rather than the raw record. `["get", "ssn"]` in a title
 * or body would otherwise reach a column the author hid, printing it into the
 * popup — and onto the hover tooltip, which needs no click at all. The rest of
 * this module already honors `fieldVisibility` field by field; an expression
 * has no field list to filter, so the filtering has to happen to its input.
 */
export function visiblePopupProperties(
  properties: Record<string, unknown>,
  fieldVisibility?: Record<string, FieldVisibility>,
): Record<string, unknown> {
  const visible: Record<string, unknown> = {};
  for (const key of visiblePopupFields(properties, fieldVisibility)) {
    visible[key] = properties[key];
  }
  return visible;
}

/** Options for {@link resolvePopupRows}. */
export interface ResolvePopupRowsOptions extends PopupFormatOptions {
  popup?: LayerPopupConfig;
  fieldVisibility?: Record<string, FieldVisibility>;
  /** Resolve the hover subset (fields flagged `hover`) instead of the full list. */
  hover?: boolean;
}

/**
 * The rows a popup (or hover tooltip) should render for one feature's
 * properties.
 *
 * With no `popup.fields`, every visible property is returned in the feature's
 * own key order and left untyped, which is exactly what the popup did before
 * the designer existed. With a list, only the listed fields appear, in the
 * listed order, under their labels and formats — and a listed field the
 * feature does not carry is skipped rather than printed empty, so one config
 * can cover a layer whose features have ragged properties.
 *
 * `hover: true` narrows the list to fields flagged `hover`. A hover request
 * with no flagged field returns nothing: an author who turned the tooltip on
 * without choosing a field gets no tip rather than the whole table following
 * the pointer.
 */
export function resolvePopupRows(
  properties: Record<string, unknown>,
  options: ResolvePopupRowsOptions = {},
): PopupRow[] {
  const { popup, fieldVisibility, hover = false, locale } = options;
  // Untrusted JSON again: `fields` may be absent, a non-array, or hold entries
  // whose `field` is not a string. Anything unusable is dropped here so the
  // loop below can treat every entry as a real field name.
  const configured = (Array.isArray(popup?.fields) ? popup.fields : []).filter(
    (config): config is PopupFieldConfig =>
      Boolean(config) && typeof (config as PopupFieldConfig).field === "string",
  );

  if (configured.length === 0) {
    if (hover) return [];
    return visiblePopupFields(properties, fieldVisibility).map((field) => ({
      field,
      label: field,
      value: properties[field],
      text: stringifyPopupValue(properties[field]),
      kind: "auto" as const,
    }));
  }

  const rows: PopupRow[] = [];
  const seen = new Set<string>();
  for (const config of configured) {
    if (hover && config.hover !== true) continue;
    // fieldVisibility wins: a popup config can order and relabel what is
    // visible, it can never re-expose a field the author hid or excluded.
    if (fieldVisibility?.[config.field]) continue;
    if (isInternalPopupField(config.field)) continue;
    if (!(config.field in properties)) continue;
    if (seen.has(config.field)) continue;
    const value = properties[config.field];
    // A hover tip is a glance, and it re-renders on every animation frame the
    // pointer is over the feature. An image row has no useful text form — its
    // value is a multi-kilobyte data URL — so it would print that URL as the
    // tip's body, over and over. Skip it and let the click popup show the
    // picture.
    if (hover && rendersAsImage(config.kind ?? "auto", value)) continue;
    seen.add(config.field);
    rows.push({
      field: config.field,
      label: popupFieldLabel(config),
      value,
      text: formatPopupValue(value, config, { locale }),
      kind: config.kind ?? "auto",
      ...(trimmedString(config.format?.linkLabel)
        ? { linkLabel: trimmedString(config.format?.linkLabel) }
        : {}),
    });
  }
  return rows;
}

/**
 * Compiled title/body expressions, keyed by zoom and source.
 *
 * `createHoverTooltipElement` calls {@link resolvePopupTitle} once per
 * animation frame for as long as the pointer sits on a hovered feature, and
 * compiling means a `JSON.parse` plus a full style-spec validation. Without
 * this the same unchanged source string would be re-parsed sixty times a
 * second. Zoom is part of the key because a compiled expression bakes it in
 * for `["zoom"]`; it is constant through a hover, so the cache still hits.
 */
const EXPRESSION_CACHE = new Map<string, CompiledFeatureExpression>();
/** Bound on the cache, so a project full of layers cannot grow it without end. */
const EXPRESSION_CACHE_LIMIT = 64;

function compiledPopupExpression(source: string, zoom: number): CompiledFeatureExpression {
  const key = `${zoom}\u0000${source}`;
  const cached = EXPRESSION_CACHE.get(key);
  if (cached) return cached;
  const compiled = compileFeatureExpression(source, { zoom });
  // Map iterates in insertion order, so the first key is the oldest entry.
  if (EXPRESSION_CACHE.size >= EXPRESSION_CACHE_LIMIT) {
    const oldest = EXPRESSION_CACHE.keys().next().value;
    if (oldest !== undefined) EXPRESSION_CACHE.delete(oldest);
  }
  EXPRESSION_CACHE.set(key, compiled);
  return compiled;
}

/**
 * Evaluate a popup expression against a feature's properties, or return
 * `undefined` when it does not compile or throws. Both failures mean the same
 * thing to every caller here: fall back to what the popup would show without
 * the expression.
 */
function evaluatePopupExpression(
  source: string,
  properties: Record<string, unknown>,
  options: PopupExpressionOptions,
): unknown {
  const compiled = compiledPopupExpression(source, options.zoom ?? 0);
  if (!compiled.ok || !compiled.evaluate) return undefined;
  try {
    return compiled.evaluate(
      featureFor(visiblePopupProperties(properties, options.fieldVisibility), options.feature),
    );
  } catch {
    return undefined;
  }
}

/** Build the synthetic feature an expression is evaluated against. */
function featureFor(properties: Record<string, unknown>, feature?: Feature | null): Feature {
  if (feature) return { ...feature, properties };
  return { type: "Feature", geometry: null as never, properties };
}

/** Options for {@link resolvePopupTitle} and {@link resolvePopupBody}. */
export interface PopupExpressionOptions {
  /**
   * The author's field visibility, so an expression cannot read a hidden or
   * excluded column. Omitting it means nothing is hidden.
   */
  fieldVisibility?: Record<string, FieldVisibility>;
  /** The real feature, when the caller has one — feeds `["geometry-type"]`. */
  feature?: Feature | null;
  /** Map zoom for `["zoom"]`; defaults to 0. */
  zoom?: number;
}

/**
 * The heading a popup should show: the title expression's value, else the
 * title field's value, else the layer name. An expression that fails to
 * compile or evaluate, and a title field that is empty or hidden, both fall
 * back to the layer name rather than leaving the popup headless.
 */
export function resolvePopupTitle(
  layerName: string,
  properties: Record<string, unknown>,
  popup: LayerPopupConfig | undefined,
  options: PopupExpressionOptions = {},
): string {
  return resolveConfiguredPopupTitle(properties, popup, options) ?? layerName;
}

/**
 * The title the author's own configuration produced, or `null` when there is
 * none — no title field or expression, or one that evaluated to nothing, or a
 * field the author hid.
 *
 * {@link resolvePopupTitle} is this plus the layer-name fallback. The hover
 * tooltip needs the two apart: a tip with no fields and no configured title
 * would be a box repeating the layer name, so it is suppressed — but that
 * decision has to rest on whether a title was *configured*, not on whether the
 * resolved text happens to equal the layer name. A city layer named "Olympia"
 * whose feature is also called "Olympia" is a real title, not a fallback.
 */
export function resolveConfiguredPopupTitle(
  properties: Record<string, unknown>,
  popup: LayerPopupConfig | undefined,
  options: PopupExpressionOptions = {},
): string | null {
  const source = trimmedString(popup?.titleExpression);
  if (source) {
    const text = stringifyPopupValue(evaluatePopupExpression(source, properties, options)).trim();
    if (text) return text;
  }
  const field = trimmedString(popup?.titleField);
  if (field && !options.fieldVisibility?.[field] && !isInternalPopupField(field)) {
    const text = stringifyPopupValue(properties[field]).trim();
    if (text) return text;
  }
  return null;
}

/**
 * The popup body text when the author supplied a body expression, or `null`
 * when there is none (or it failed) and the field rows should render instead.
 */
export function resolvePopupBody(
  properties: Record<string, unknown>,
  popup: LayerPopupConfig | undefined,
  options: PopupExpressionOptions = {},
): string | null {
  const source = trimmedString(popup?.bodyExpression);
  if (!source) return null;
  const preview = evaluatePopupExpression(source, properties, options);
  if (preview === undefined) return null;
  const text = stringifyPopupValue(preview);
  return text.trim() ? text : null;
}

/**
 * Whether a value should render as an inline image thumbnail under `"auto"`.
 * Kept here so the renderer and the designer's preview agree on what counts.
 */
export function isInlineImageValue(value: unknown): value is string {
  return typeof value === "string" && INLINE_IMAGE_DATA_URL.test(value);
}

/**
 * Whether a URL is safe to put in a popup `href`/`src`. Only http(s) and
 * inline raster data URLs: a `javascript:` or `data:text/html` value coming
 * from an untrusted GeoJSON must never become a live link.
 */
export function isSafePopupUrl(value: unknown, allowDataImage = false): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return true;
  return allowDataImage && INLINE_IMAGE_DATA_URL.test(trimmed);
}
