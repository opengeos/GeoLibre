/** Project-owned fields for GeoEditor's feature-properties form. */
export interface GeoEditorAttributeField {
  name: string;
  label?: string;
  type: "string" | "number" | "boolean" | "color" | "date" | "textarea";
  geometry: "all" | "polygon" | "line" | "point";
}

export interface GeoEditorSettings {
  showAfterDraw: boolean;
  fields: GeoEditorAttributeField[];
  /**
   * Snapping tolerance in screen pixels for vertex and segment snapping, used
   * by the editor's drawing tools and by COGO/trace picking. Absent means
   * {@link DEFAULT_GEO_EDITOR_SNAP_TOLERANCE_PX}.
   */
  snapTolerancePx?: number;
}

/** Default snapping tolerance in pixels (Geoman's own default). */
export const DEFAULT_GEO_EDITOR_SNAP_TOLERANCE_PX = 18;
/** Smallest and largest accepted snapping tolerance, in pixels. */
export const GEO_EDITOR_SNAP_TOLERANCE_RANGE = [1, 100] as const;

/**
 * The effective snapping tolerance in pixels for (possibly unnormalized)
 * editor settings: the stored value clamped to the accepted range, or the
 * default when none is stored.
 */
export function geoEditorSnapTolerancePx(settings: Partial<GeoEditorSettings> | undefined): number {
  const value = settings?.snapTolerancePx;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_GEO_EDITOR_SNAP_TOLERANCE_PX;
  }
  const [min, max] = GEO_EDITOR_SNAP_TOLERANCE_RANGE;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export const DEFAULT_GEO_EDITOR_SETTINGS: GeoEditorSettings = {
  showAfterDraw: true,
  fields: [{ name: "height", type: "number", geometry: "polygon" }],
};

/** Names used by the control's quoted attribute selectors and plain property maps. */
export function isGeoEditorFieldName(name: string): boolean {
  return (
    name.trim().length > 0 &&
    !name.startsWith("__") &&
    name !== "prototype" &&
    !Object.hasOwn(Object.prototype, name) &&
    !/["\\\u0000-\u001f\u007f]/u.test(name)
  );
}

/** Normalize settings loaded from a project, keeping only supported, unique fields. */
export function normalizeGeoEditorSettings(raw: unknown): GeoEditorSettings {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const fields: GeoEditorAttributeField[] = [];
  const names = new Set<string>();
  for (const item of Array.isArray(value.fields)
    ? value.fields
    : DEFAULT_GEO_EDITOR_SETTINGS.fields) {
    if (!item || typeof item !== "object") continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!isGeoEditorFieldName(name) || names.has(name)) continue;
    if (!["string", "number", "boolean", "color", "date", "textarea"].includes(item.type)) continue;
    if (!["all", "polygon", "line", "point"].includes(item.geometry)) continue;
    names.add(name);
    fields.push({
      name,
      type: item.type,
      geometry: item.geometry,
      ...(typeof item.label === "string" && item.label.trim() ? { label: item.label.trim() } : {}),
    });
  }
  return {
    showAfterDraw: typeof value.showAfterDraw === "boolean" ? value.showAfterDraw : true,
    fields,
    ...(typeof value.snapTolerancePx === "number" && Number.isFinite(value.snapTolerancePx)
      ? { snapTolerancePx: geoEditorSnapTolerancePx({ snapTolerancePx: value.snapTolerancePx }) }
      : {}),
  };
}
