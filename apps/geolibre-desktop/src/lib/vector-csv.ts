import type { FeatureCollection } from "geojson";
import { csvCell, spreadsheetSafeText } from "./csv";

/** Render an attribute value as the plain string used in CSV cells and inputs. */
export function formatAttributeValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Export attributes with WGS84 longitude/latitude for Point features.
 * Non-point rows have empty coordinate cells. Existing attributes are retained;
 * generated column names receive a numeric suffix when a property uses the name.
 */
export function geojsonToCsv(geojson: FeatureCollection): string {
  const propertyKeys = new Set<string>();
  for (const feature of geojson.features) {
    for (const key of Object.keys(feature.properties ?? {})) propertyKeys.add(key);
  }
  const orderedKeys = Array.from(propertyKeys);
  const unique = (base: string): string => {
    let name = base;
    for (let suffix = 2; propertyKeys.has(name); suffix++) name = base + "_" + suffix;
    propertyKeys.add(name);
    return name;
  };
  const headers = [unique("feature_id"), ...orderedKeys];
  const hasPoints = geojson.features.some((feature) => feature.geometry?.type === "Point");
  if (hasPoints) headers.push(unique("longitude"), unique("latitude"));
  const rows = geojson.features.map((feature, index) => {
    const properties = feature.properties ?? {};
    const values: unknown[] = [feature.id ?? index, ...orderedKeys.map((key) => properties[key])];
    if (hasPoints) {
      const coordinates = feature.geometry?.type === "Point" ? feature.geometry.coordinates : [];
      values.push(...[coordinates[0], coordinates[1]].map((n) => (Number.isFinite(n) ? n : "")));
    }
    return values
      .map((value) =>
        csvCell(
          typeof value === "string" ? spreadsheetSafeText(value) : formatAttributeValue(value),
        ),
      )
      .join(",");
  });
  return [headers.map((header) => csvCell(spreadsheetSafeText(header))).join(","), ...rows].join(
    "\n",
  );
}
