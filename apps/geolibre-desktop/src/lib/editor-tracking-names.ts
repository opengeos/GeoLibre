import { DEFAULT_EDITOR_TRACKING_CONFIG } from "@geolibre/core";

/**
 * Validation for the four editor tracking column names, split out of
 * `EditorTrackingSection.tsx` so it can be unit tested without React. The rules
 * guard against silent data loss, so they are worth pinning directly.
 */

/** The four configurable column names, in the order the panel shows them. */
export const EDITOR_TRACKING_FIELD_KEYS = [
  "createdByField",
  "createdAtField",
  "editedByField",
  "editedAtField",
] as const;

export type EditorTrackingFieldKey = (typeof EDITOR_TRACKING_FIELD_KEYS)[number];

/** The default name for each configurable column. */
export const DEFAULT_EDITOR_TRACKING_NAMES = Object.fromEntries(
  EDITOR_TRACKING_FIELD_KEYS.map((key) => [key, DEFAULT_EDITOR_TRACKING_CONFIG[key]]),
) as Record<EditorTrackingFieldKey, string>;

/** A rejected name set: why it was rejected, and the name that caused it. */
export type EditorTrackingNameProblem =
  | { reason: "blankName" | "duplicateName" }
  | { reason: "columnTaken"; name: string };

/**
 * Why a set of tracking column names is unusable, or `null` when it is fine.
 *
 * The blank/duplicate rules mirror what `resolveEditorTrackingConfig` enforces,
 * so the panel reports them as a message instead of letting them surface as a
 * throw when a feature is stamped. The third rule has no equivalent in core,
 * which cannot see the layer's data: a tracking column is written
 * unconditionally on every stamp, so pointing one at a name that already holds
 * real attribute values would overwrite them silently, feature by feature, with
 * none of the protection `renameColumn` gives an ordinary column.
 *
 * @param names The four names as currently typed.
 * @param dataColumns The layer's attribute columns, with the ones tracking
 *   already maintains removed by the caller — pointing a tracking column back at
 *   its own current name is how renaming works, and a layer that already has a
 *   `created_by` column is taken over by the identically-named default rather
 *   than being refused, since that is a match in meaning, not a collision.
 * @returns The problem, or `null` when the names are usable.
 */
export function editorTrackingNameProblem(
  names: Record<EditorTrackingFieldKey, string>,
  dataColumns: ReadonlySet<string>,
): EditorTrackingNameProblem | null {
  const values = EDITOR_TRACKING_FIELD_KEYS.map((key) => names[key].trim());
  if (values.some((value) => value === "")) return { reason: "blankName" };
  if (new Set(values).size !== values.length) return { reason: "duplicateName" };
  const taken = values.find((value) => dataColumns.has(value));
  if (taken !== undefined) return { reason: "columnTaken", name: taken };
  return null;
}
