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
}

export const DEFAULT_GEO_EDITOR_SETTINGS: GeoEditorSettings = {
  showAfterDraw: true,
  fields: [{ name: "height", type: "number", geometry: "polygon" }],
};

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
    if (
      !name ||
      !/^[\p{L}_][\p{L}\p{N}_-]*$/u.test(name) ||
      name.startsWith("__") ||
      ["constructor", "prototype"].includes(name) ||
      names.has(name)
    )
      continue;
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
  };
}
