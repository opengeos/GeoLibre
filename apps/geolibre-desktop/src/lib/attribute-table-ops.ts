import type { AttributeTableDrafts as AttributeDrafts } from "@geolibre/core";
import { formatAttributeValue } from "./vector-csv";

export type SortDirection = "asc" | "desc";
export type SortKey = "__featureId" | string;

export interface AttributeTableRow {
  featureId: string;
  properties: Record<string, unknown>;
}

const ATTRIBUTE_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function compareAttributeValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;

  if (typeof a === "number" && typeof b === "number") return a - b;

  const aNumber = Number(a);
  const bNumber = Number(b);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
    return aNumber - bNumber;
  }

  return ATTRIBUTE_COLLATOR.compare(String(a), String(b));
}

function getDraftRow(
  drafts: AttributeDrafts,
  featureId: string,
): Record<string, string> | undefined {
  return Object.hasOwn(drafts, featureId) ? drafts[featureId] : undefined;
}

export interface SortSpec {
  key: SortKey;
  direction: SortDirection;
}

export type ColumnFilterMode = "contains" | "equals" | "range" | "is-null" | "not-null";

export interface ColumnFilterSpec {
  mode: ColumnFilterMode;
  text?: string;
  min?: string;
  max?: string;
}

/**
 * Update a multi-column sort stack when a column header is clicked.
 *
 * Plain click replaces the sort stack with a single key (or flips its direction
 * if it was already the sole primary sort). Additive (Shift+click) appends a
 * secondary sort key, flips its direction if already present (asc -> desc), or
 * removes it when flipped past desc (unless it is the only sort key).
 */
export function toggleMultiSort(
  current: readonly SortSpec[],
  key: SortKey,
  additive: boolean,
): SortSpec[] {
  if (!additive) {
    if (current.length === 1 && current[0].key === key) {
      return [{ key, direction: current[0].direction === "asc" ? "desc" : "asc" }];
    }
    return [{ key, direction: "asc" }];
  }
  const idx = current.findIndex((spec) => spec.key === key);
  if (idx === -1) {
    return [...current, { key, direction: "asc" }];
  }
  const existing = current[idx];
  if (existing.direction === "asc") {
    return current.map((spec, i) => (i === idx ? { ...spec, direction: "desc" } : spec));
  }
  if (current.length === 1) {
    return [{ key, direction: "asc" }];
  }
  return current.filter((_, i) => i !== idx);
}

/** Sort attribute table rows using an ordered stack of sort specifications. */
export function sortAttributeRows(
  rows: readonly AttributeTableRow[],
  specs: readonly SortSpec[],
): AttributeTableRow[] {
  if (specs.length === 0) return [...rows];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      const aValue = spec.key === "__featureId" ? a.featureId : a.properties[spec.key];
      const bValue = spec.key === "__featureId" ? b.featureId : b.properties[spec.key];
      const cmp = compareAttributeValues(aValue, bValue);
      if (cmp !== 0) {
        return spec.direction === "asc" ? cmp : -cmp;
      }
    }
    return 0;
  });
}

/** True when a column filter specification constrains rows. */
export function hasActiveColumnFilter(spec: ColumnFilterSpec | undefined): boolean {
  if (!spec) return false;
  if (spec.mode === "is-null" || spec.mode === "not-null") return true;
  if (spec.mode === "range") {
    return Boolean(spec.min?.trim() || spec.max?.trim());
  }
  return Boolean(spec.text?.trim());
}

/** Evaluate a single cell value against a per-column filter specification. */
export function matchesColumnFilter(value: unknown, spec: ColumnFilterSpec): boolean {
  const isNullish = value === null || value === undefined || value === "";
  if (spec.mode === "is-null") return isNullish;
  if (spec.mode === "not-null") return !isNullish;
  if (spec.mode === "range") {
    const minStr = spec.min?.trim() ?? "";
    const maxStr = spec.max?.trim() ?? "";
    if (!minStr && !maxStr) return true;
    const num =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== ""
          ? Number(value)
          : NaN;
    if (!Number.isFinite(num)) return false;
    if (minStr) {
      const min = Number(minStr);
      if (Number.isFinite(min) && num < min) return false;
    }
    if (maxStr) {
      const max = Number(maxStr);
      if (Number.isFinite(max) && num > max) return false;
    }
    return true;
  }
  const needle = (spec.text ?? "").trim().toLowerCase();
  if (!needle) return true;
  const hay = formatAttributeValue(value).toLowerCase();
  return spec.mode === "equals" ? hay === needle : hay.includes(needle);
}

/** Filter rows by all active per-column filter specifications. */
export function filterAttributeRowsByColumns(
  rows: readonly AttributeTableRow[],
  filters: Readonly<Record<string, ColumnFilterSpec>>,
): AttributeTableRow[] {
  const active = Object.entries(filters).filter(([, spec]) => hasActiveColumnFilter(spec));
  if (active.length === 0) return [...rows];
  return rows.filter((row) =>
    active.every(([col, spec]) =>
      matchesColumnFilter(col === "__featureId" ? row.featureId : row.properties[col], spec),
    ),
  );
}

function setDraftCell(
  drafts: AttributeDrafts,
  featureId: string,
  column: string,
  nextValue: string,
  originalValue: unknown,
): AttributeDrafts {
  const row = { ...getDraftRow(drafts, featureId) };
  if (nextValue === formatAttributeValue(originalValue)) {
    delete row[column];
  } else {
    row[column] = nextValue;
  }
  const next: AttributeDrafts = { ...drafts };
  if (Object.keys(row).length > 0) next[featureId] = row;
  else delete next[featureId];
  return next;
}

/**
 * Bulk-fill `column` with `value` across all rows whose `featureId` is in
 * `targetRowIds`, returning updated drafts through the standard edit path.
 */
export function computeBulkFillDrafts(options: {
  rows: readonly AttributeTableRow[];
  targetRowIds: ReadonlySet<string>;
  column: string;
  value: string;
  currentDrafts: AttributeDrafts;
}): { drafts: AttributeDrafts; updatedCount: number } {
  const { rows, targetRowIds, column, value, currentDrafts } = options;
  let drafts = currentDrafts;
  let updatedCount = 0;
  for (const row of rows) {
    if (!targetRowIds.has(row.featureId)) continue;
    const original = row.properties[column];
    const currentText =
      getDraftRow(drafts, row.featureId)?.[column] ?? formatAttributeValue(original);
    if (currentText === value) continue;
    drafts = setDraftCell(drafts, row.featureId, column, value, original);
    updatedCount += 1;
  }
  return { drafts, updatedCount };
}

/**
 * Find & Replace within `column` across all rows in `targetRowIds`, returning
 * updated drafts and the number of cells modified.
 */
export function computeFindReplaceDrafts(options: {
  rows: readonly AttributeTableRow[];
  targetRowIds: ReadonlySet<string>;
  column: string;
  find: string;
  replace: string;
  matchCase?: boolean;
  wholeCell?: boolean;
  currentDrafts: AttributeDrafts;
}): { drafts: AttributeDrafts; updatedCount: number } {
  const {
    rows,
    targetRowIds,
    column,
    find,
    replace,
    matchCase = false,
    wholeCell = false,
    currentDrafts,
  } = options;
  if (!find) return { drafts: currentDrafts, updatedCount: 0 };

  let drafts = currentDrafts;
  let updatedCount = 0;
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = wholeCell
    ? new RegExp(`^${escaped}$`, matchCase ? "" : "i")
    : new RegExp(escaped, matchCase ? "g" : "gi");

  for (const row of rows) {
    if (!targetRowIds.has(row.featureId)) continue;
    const original = row.properties[column];
    const currentText =
      getDraftRow(drafts, row.featureId)?.[column] ?? formatAttributeValue(original);
    if (!pattern.test(currentText)) {
      pattern.lastIndex = 0;
      continue;
    }
    pattern.lastIndex = 0;
    const nextText = currentText.replace(pattern, () => replace);
    if (nextText === currentText) continue;
    drafts = setDraftCell(drafts, row.featureId, column, nextText, original);
    updatedCount += 1;
  }
  return { drafts, updatedCount };
}
