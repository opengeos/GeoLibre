import type { Feature, FeatureCollection } from "geojson";
import type { EditorTrackingConfig } from "./types";

/** Default field names for maintained editor tracking columns. */
export const DEFAULT_EDITOR_TRACKING_CONFIG: Required<EditorTrackingConfig> = {
  enabled: false,
  createdByField: "created_by",
  createdAtField: "created_at",
  editedByField: "edited_by",
  editedAtField: "edited_at",
};

/**
 * Identity written to the author fields when nothing better is known.
 *
 * Deliberately NOT translated: it is written into the user's data, where a
 * value that changes with the UI language would make the same editor appear as
 * several different people across a project's history.
 */
export const DEFAULT_EDITOR_IDENTITY = "local-user";

/**
 * `localStorage` key holding the display name this browser edits under.
 *
 * Shared with the Comments panel, which asks for the same name and stores it
 * here, so a user who has introduced themselves once is recognized by both
 * features instead of being prompted twice.
 */
export const EDITOR_IDENTITY_STORAGE_KEY = "geolibre_author_name";

/**
 * Choose the identity to stamp, most authoritative source first.
 *
 * A live collaboration session names its participants, so that name wins: it is
 * the one other people in the session see attached to the same edits. Otherwise
 * fall back to the locally configured display name, then to
 * {@link DEFAULT_EDITOR_IDENTITY}.
 *
 * @param collabName Display name from an active collaboration session.
 * @param storedName Locally configured display name.
 * @returns A non-empty identity string.
 */
export function pickEditorIdentity(collabName?: string | null, storedName?: string | null): string {
  return collabName?.trim() || storedName?.trim() || DEFAULT_EDITOR_IDENTITY;
}

/**
 * The four maintained column names, or `null` when tracking is off or the
 * configuration is unusable. Ordered created-then-edited so callers that render
 * the columns get a stable, meaningful order.
 */
export function editorTrackingFieldNames(config?: EditorTrackingConfig): string[] | null {
  const resolved = resolveEditorTrackingConfigForQuery(config);
  if (!resolved?.enabled) return null;
  return [
    resolved.createdByField,
    resolved.createdAtField,
    resolved.editedByField,
    resolved.editedAtField,
  ];
}

/**
 * Options for editor tracking stamping functions.
 */
export interface EditorTrackingStampOptions {
  /** Optional custom editor tracking field configuration. */
  config?: EditorTrackingConfig;
  /**
   * Identity string of the author/editor (e.g. username, email, or client ID).
   * Defaults to {@link DEFAULT_EDITOR_IDENTITY}.
   */
  userIdentity?: string;
  /** ISO timestamp override for deterministic testing or batch operations. Defaults to `new Date().toISOString()`. */
  timestamp?: string;
}

/**
 * Fully resolve an {@link EditorTrackingConfig} with fallback default field names.
 */
export function resolveEditorTrackingConfig(
  config?: EditorTrackingConfig,
): Required<EditorTrackingConfig> {
  // Trimmed on the way in, because these become literal GeoJSON property keys:
  // a name typed as `" created_by "` in the settings form would otherwise pass
  // validation and then write a column whose name has invisible padding,
  // matching neither what the user typed nor the default it looks like.
  const resolved = {
    enabled: config?.enabled ?? DEFAULT_EDITOR_TRACKING_CONFIG.enabled,
    createdByField: (
      config?.createdByField ?? DEFAULT_EDITOR_TRACKING_CONFIG.createdByField
    ).trim(),
    createdAtField: (
      config?.createdAtField ?? DEFAULT_EDITOR_TRACKING_CONFIG.createdAtField
    ).trim(),
    editedByField: (config?.editedByField ?? DEFAULT_EDITOR_TRACKING_CONFIG.editedByField).trim(),
    editedAtField: (config?.editedAtField ?? DEFAULT_EDITOR_TRACKING_CONFIG.editedAtField).trim(),
  };

  // Tracking that is off writes nothing, so the names cannot matter — and a
  // half-filled or hand-edited config left behind on a disabled layer must not
  // make every save on that layer throw. Validate only what will be used.
  if (!resolved.enabled) return resolved;

  const fields = [
    resolved.createdByField,
    resolved.createdAtField,
    resolved.editedByField,
    resolved.editedAtField,
  ];
  if (fields.some((field) => field === "") || new Set(fields).size !== fields.length) {
    throw new Error("Editor tracking field names must be non-empty and unique");
  }

  return resolved;
}

/**
 * Resolve a config for the query helpers, yielding `null` rather than throwing when
 * the configured field names are blank or collide.
 *
 * The query helpers run once per field on every Attribute Table / Field Calculator
 * render, and the field names are user-editable strings, so a half-filled settings
 * form or a hand-edited `.geolibre.json` must degrade to "tracking off" instead of
 * crashing the panel. The stamping helpers keep the throw: a write that silently
 * skipped tracking would leave a layer looking tracked while recording nothing.
 */
function resolveEditorTrackingConfigForQuery(
  config?: EditorTrackingConfig,
): Required<EditorTrackingConfig> | null {
  try {
    return resolveEditorTrackingConfig(config);
  } catch {
    return null;
  }
}

/**
 * Check whether a field name corresponds to one of the maintained editor tracking columns.
 *
 * Returns `false` for an invalid config, so callers can use this as a plain predicate.
 */
export function isMaintainedEditorTrackingField(
  fieldName: string,
  config?: EditorTrackingConfig,
): boolean {
  const resolved = resolveEditorTrackingConfigForQuery(config);
  if (!resolved?.enabled) {
    return false;
  }
  return (
    fieldName === resolved.createdByField ||
    fieldName === resolved.createdAtField ||
    fieldName === resolved.editedByField ||
    fieldName === resolved.editedAtField
  );
}

/**
 * Ensure all configured editor tracking field names are included in a field list.
 *
 * Returns the list unchanged for an invalid config, matching
 * {@link isMaintainedEditorTrackingField}.
 */
export function ensureEditorTrackingFields(
  fields: string[],
  config?: EditorTrackingConfig,
): string[] {
  const trackingFields = editorTrackingFieldNames(config);
  if (!trackingFields) {
    return fields;
  }
  const result = [...fields];
  for (const tf of trackingFields) {
    if (!result.includes(tf)) {
      result.push(tf);
    }
  }
  return result;
}

/**
 * Stamp editor tracking metadata onto a feature's properties object.
 *
 * On `"create"`: sets all four columns to this editor and this timestamp.
 * `"create"` states that the feature is being created here and now, so it is
 * authoritative — a value already sitting in one of these columns describes
 * some other feature, not this one. That case is reachable: the geometry
 * editor's copy action clones a tracked feature's properties, and a Field
 * Collection form can define a capture field whose key happens to be a tracking
 * column. Both would otherwise credit a brand-new feature to whoever created
 * the thing it was copied from.
 *
 * On `"update"`: sets `edited_by`/`edited_at` and preserves `created_by` /
 * `created_at`, which record something this edit did not change.
 */
export function stampFeaturePropertiesEditorTracking(
  properties: Record<string, unknown> | null | undefined,
  action: "create" | "update",
  options?: EditorTrackingStampOptions,
): Record<string, unknown> {
  const resolved = resolveEditorTrackingConfig(options?.config);
  if (!resolved.enabled) {
    return properties ? { ...properties } : {};
  }

  const result: Record<string, unknown> = properties ? { ...properties } : {};
  const now = options?.timestamp ?? new Date().toISOString();
  const actor = options?.userIdentity || DEFAULT_EDITOR_IDENTITY;

  if (action === "create") {
    result[resolved.createdByField] = actor;
    result[resolved.createdAtField] = now;
  }

  result[resolved.editedByField] = actor;
  result[resolved.editedAtField] = now;

  return result;
}

/**
 * Stamp editor tracking metadata onto a GeoJSON {@link Feature}.
 */
export function stampFeatureEditorTracking<T extends Feature>(
  feature: T,
  action: "create" | "update",
  options?: EditorTrackingStampOptions,
): T {
  const resolved = resolveEditorTrackingConfig(options?.config);
  if (!resolved.enabled) {
    return feature;
  }

  return {
    ...feature,
    properties: stampFeaturePropertiesEditorTracking(feature.properties, action, options),
  };
}

/**
 * Stamp editor tracking metadata onto all features in a {@link FeatureCollection}.
 */
export function stampFeatureCollectionEditorTracking(
  collection: FeatureCollection,
  action: "create" | "update",
  options?: EditorTrackingStampOptions,
): FeatureCollection {
  const resolved = resolveEditorTrackingConfig(options?.config);
  if (!resolved.enabled) {
    return collection;
  }

  const timestamp = options?.timestamp ?? new Date().toISOString();
  const opts = { ...options, timestamp };

  return {
    ...collection,
    features: collection.features.map((feat) => stampFeatureEditorTracking(feat, action, opts)),
  };
}
