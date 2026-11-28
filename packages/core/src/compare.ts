/**
 * Pin and compare: pin one feature, then hovering another feature of the same
 * layer shows how its attributes differ from the pinned one ("+42,000",
 * "was Residential"), the way an assessor compares a parcel with its
 * neighbors.
 *
 * Pure helpers, so the comparison can be tested without a map or a DOM. The
 * engines' hover tooltips render the result (`createHoverTooltipElement`).
 * The comparison goes through the same field rules as the Identify popup:
 * {@link resolvePopupRows} picks the fields, their order, labels and
 * formatting, so a field the author hid never shows up in a comparison either.
 */
import {
  formatPopupValue,
  isInlineImageList,
  isInlineImageValue,
  isPopupHoverEnabled,
  resolvePopupRows,
  type PopupFormatOptions,
  type PopupRow,
} from "./popup";
import type { FieldVisibility, GeoLibreLayer, LayerPopupConfig, PopupFieldConfig } from "./types";

/** The feature the hovered ones are compared with. Session state, never saved. */
export interface ComparePin {
  /** Store layer the pinned feature belongs to. Only that layer compares. */
  layerId: string;
  /** The pinned feature's id, as the selection stores it. */
  featureId: string;
  /** The pinned feature's attributes, as they were when it was pinned. */
  properties: Record<string, unknown>;
}

/** One field that differs between the hovered and the pinned feature. */
export interface CompareRow {
  field: string;
  /** The field's popup label. */
  label: string;
  /** The hovered feature's value, formatted as the popup formats it. */
  text: string;
  /** The pinned feature's value, formatted the same way; empty when it has none. */
  pinnedText: string;
  /**
   * Hovered minus pinned, signed and formatted (`+42,000`, `−0.3`), when both
   * values are numbers. Absent for text, dates, and identifier columns, where
   * the pinned value is shown instead.
   */
  delta?: string;
}

/** How a hovered feature differs from the pinned one. */
export interface FeatureComparison {
  /** The fields that differ, in popup order, at most `maxRows` of them. */
  rows: CompareRow[];
  /** Differing fields left out past `maxRows`. */
  moreCount: number;
  /** Fields both features show with the same value. */
  sameCount: number;
}

/** Most differing fields listed: the tooltip is a glance, not the table. */
export const COMPARE_MAX_ROWS = 8;

export interface CompareOptions extends PopupFormatOptions {
  popup?: LayerPopupConfig;
  fieldVisibility?: Record<string, FieldVisibility>;
  /** See {@link COMPARE_MAX_ROWS}. */
  maxRows?: number;
}

/**
 * Identifier columns hold numbers whose difference means nothing ("OBJECTID
 * +5"), so they are compared as text.
 */
const IDENTIFIER_FIELD = /^(id|fid|gid|oid|objectid|ogc_fid)$/i;

/** The minus sign, not a hyphen, so a negative delta reads as one. */
const MINUS = "−";

/** Whether a row draws as a picture, which has no text to compare. */
function isImageRow(row: PopupRow): boolean {
  return row.kind === "image" || isInlineImageValue(row.value) || isInlineImageList(row.value);
}

/**
 * The number a value holds for the comparison: a finite number, or, for a
 * field the author formats as a number, a numeric string. Other strings stay
 * text even when they look numeric, so a zero-padded parcel number like
 * "00123" is never subtracted from another. A field the author gave another
 * kind is not a quantity whatever it holds: a date stored as epoch
 * milliseconds compares as the two dates, not as a count of milliseconds.
 */
function numericValue(value: unknown, config: PopupFieldConfig | undefined): number | null {
  const kind = config?.kind ?? "auto";
  if (kind !== "auto" && kind !== "number") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (kind === "number" && typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Format the difference between two numbers with a sign. A field the author
 * formats as a number keeps that format (decimals, grouping, prefix, suffix:
 * `+$42,000`); any other number gets grouping and up to two decimals.
 */
function formatDelta(
  difference: number,
  config: PopupFieldConfig | undefined,
  locale: string | undefined,
): string {
  const format = (value: number) =>
    config?.kind === "number"
      ? formatPopupValue(value, config, { locale })
      : new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  const body = format(Math.abs(difference));
  // A difference that rounds to nothing at the displayed precision has no
  // sign. Compared with a formatted zero rather than by looking for digits,
  // which are not 1-9 in every locale's numbering system.
  if (body === format(0)) return body;
  return `${difference > 0 ? "+" : MINUS}${body}`;
}

/**
 * Compare a hovered feature's attributes with the pinned feature's.
 *
 * The fields are the ones the layer's Identify popup shows (its configured
 * list, or every visible property), in its order: the hovered feature's
 * fields first, then any only the pinned one has. Image fields are skipped.
 * A field is the same when both features format it to the same text.
 */
export function compareFeatureProperties(
  hovered: Record<string, unknown>,
  pinned: Record<string, unknown>,
  options: CompareOptions = {},
): FeatureComparison {
  const { popup, fieldVisibility, locale } = options;
  const maxRows = options.maxRows ?? COMPARE_MAX_ROWS;
  const rowOptions = { popup, fieldVisibility, locale };
  const hoveredRows = resolvePopupRows(hovered, rowOptions).filter((row) => !isImageRow(row));
  const pinnedRows = resolvePopupRows(pinned, rowOptions).filter((row) => !isImageRow(row));
  const pinnedByField = new Map(pinnedRows.map((row) => [row.field, row]));
  const hoveredFields = new Set(hoveredRows.map((row) => row.field));
  // The first configuration of a field wins, as in `resolvePopupRows`, so the
  // delta follows the same kind the row is displayed with.
  const configs = new Map<string, PopupFieldConfig>();
  for (const config of Array.isArray(popup?.fields) ? popup.fields : []) {
    if (typeof config?.field === "string" && !configs.has(config.field)) {
      configs.set(config.field, config);
    }
  }

  const differing: CompareRow[] = [];
  let sameCount = 0;
  const compare = (field: string, label: string, mine?: PopupRow, theirs?: PopupRow) => {
    const text = mine?.text ?? "";
    const pinnedText = theirs?.text ?? "";
    if (text === pinnedText) {
      sameCount++;
      return;
    }
    const config = configs.get(field);
    const a = IDENTIFIER_FIELD.test(field) ? null : numericValue(mine?.value, config);
    const b = IDENTIFIER_FIELD.test(field) ? null : numericValue(theirs?.value, config);
    differing.push({
      field,
      label,
      text,
      pinnedText,
      // Only rows that will be listed get a delta: formatting one builds
      // number formatters, and this runs on every hovered frame.
      ...(differing.length < maxRows && a !== null && b !== null
        ? { delta: formatDelta(a - b, config, locale) }
        : {}),
    });
  };
  for (const row of hoveredRows) compare(row.field, row.label, row, pinnedByField.get(row.field));
  for (const row of pinnedRows) {
    if (!hoveredFields.has(row.field)) compare(row.field, row.label, undefined, row);
  }

  return {
    rows: differing.slice(0, maxRows),
    moreCount: Math.max(0, differing.length - maxRows),
    sameCount,
  };
}

/**
 * Whether a layer's features should show a hover tooltip: the author turned
 * one on (and the viewer has not switched tooltips off), or a feature of the
 * layer is pinned for comparison. Pinning is an explicit request, so it shows
 * the comparison even with tooltips switched off.
 */
export function wantsHoverTooltip(
  layer: Pick<GeoLibreLayer, "id" | "popup">,
  state: { hoverTooltipsEnabled: boolean; comparePin: ComparePin | null },
): boolean {
  return (
    state.comparePin?.layerId === layer.id ||
    (state.hoverTooltipsEnabled && isPopupHoverEnabled(layer.popup))
  );
}

/** The pin a hovered feature of `layerId` is compared with, if any. */
export function comparePinFor(
  layerId: string,
  state: { comparePin: ComparePin | null },
): ComparePin | null {
  return state.comparePin?.layerId === layerId ? state.comparePin : null;
}
