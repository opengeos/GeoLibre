/**
 * Default values for the Field Collection capture form (issue #3398).
 *
 * A layer's Attribute Form config can give a field a default-value expression
 * (authored in the designer, or carried over from a QGIS/QField project).
 * This module supplies what those expressions are evaluated against: the
 * QField-style `@position_*` variables read off the GPS fix a point was
 * captured with, and a `transform()` hook backed by the bundled EPSG tables so
 * a project can store projected x/y the way QField does.
 */
import {
  computeAttributeFormDefaults,
  qgisExpressionReferences,
  type AttributeFormConfig,
  type QgisExpressionContext,
} from "@geolibre/core";
import { resolveEpsgProjection } from "@geolibre/map/epsg-proj4";
import type { Geometry } from "geojson";
import type { GpsFix } from "./gps-tracking";

/** Reprojects one `[x, y]` pair between two `EPSG:n` codes, or null. */
export type DefaultValueTransform = NonNullable<QgisExpressionContext["transform"]>;

/** What a capture knows when its defaults are computed. */
export interface CaptureDefaultsInput {
  /** The GPS fix the location came from; null for a point picked on the map. */
  fix: GpsFix | null;
  /** The capture target's display name (`@layer_name`). */
  layerName?: string;
  /** The project's title (`@project_title`). */
  projectTitle?: string;
  /** Who is editing (`@user_full_name`, `@cloud_username`, …). */
  user?: string;
}

/**
 * Build the `@variable` record for a capture. The `@position_*` names follow
 * QField (and its older `@gnss_*` spellings), so a QField project's defaults
 * work unchanged. They are only set when the location came from a GPS fix:
 * a point picked on the map has no accuracy to record, and QField's
 * `@position_coordinate is not null` idiom then reads as false.
 *
 * @param input - The fix and names known to the capture.
 * @returns Variable name (without `@`) to value.
 */
export function captureExpressionVariables(input: CaptureDefaultsInput): Record<string, unknown> {
  const variables: Record<string, unknown> = {};
  if (input.layerName) variables.layer_name = input.layerName;
  if (input.projectTitle) variables.project_title = input.projectTitle;
  if (input.user) {
    variables.user_full_name = input.user;
    variables.user_account_name = input.user;
    variables.cloud_username = input.user;
    variables.cloud_name = input.user;
  }
  const fix = input.fix;
  if (!fix) return variables;
  const position: Record<string, unknown> = {
    coordinate: {
      type: "Point",
      coordinates: fix.altitude == null ? [fix.lng, fix.lat] : [fix.lng, fix.lat, fix.altitude],
    },
    timestamp: new Date(fix.timestamp),
    horizontal_accuracy: Number.isFinite(fix.accuracy) ? fix.accuracy : null,
    number_of_used_satellites: fix.satellites,
    direction: fix.heading,
    ground_speed: fix.speed,
    source_name: "GPS",
  };
  for (const [name, value] of Object.entries(position)) {
    if (value == null) continue;
    variables[`position_${name}`] = value;
    variables[`gnss_${name}`] = value;
  }
  return variables;
}

/** EPSG codes named by any default expression in the form. */
export function defaultValueEpsgCodes(form: AttributeFormConfig | undefined): number[] {
  const codes = new Set<number>();
  for (const field of form?.fields ?? []) {
    for (const match of field.defaultValue?.matchAll(/EPSG:(\d{4,6})/gi) ?? []) {
      codes.add(Number(match[1]));
    }
  }
  return [...codes].sort((a, b) => a - b);
}

function epsgCode(crs: string): number | null {
  const match = /^EPSG:(\d+)$/i.exec(crs.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Resolve the projections a form's defaults name, returning a synchronous
 * `transform()` hook. The EPSG tables load asynchronously, so this runs when
 * the capture target changes; expressions evaluated before it settles (or
 * naming a CRS the tables do not know) get no value rather than a wrong one.
 *
 * @param form - The capture target's form config.
 * @returns The hook, or null when no default names an EPSG code.
 */
export async function loadDefaultValueTransform(
  form: AttributeFormConfig | undefined,
): Promise<DefaultValueTransform | null> {
  const codes = defaultValueEpsgCodes(form);
  if (codes.length === 0) return null;
  const resolved = new Map(
    await Promise.all(
      codes.map(async (code) => [code, await resolveEpsgProjection(code)] as const),
    ),
  );
  return (point, from, to) => {
    const source = resolved.get(epsgCode(from) ?? -1);
    const target = resolved.get(epsgCode(to) ?? -1);
    if (!source || !target) return null;
    try {
      const [x, y] = source.proj4(source.definition, target.definition).forward(point);
      return [x, y];
    } catch {
      return null;
    }
  };
}

/** Whether the form gives any field a default-value expression. */
export function hasAttributeFormDefaults(form: AttributeFormConfig | undefined): boolean {
  return form?.fields.some((field) => field.defaultValue?.trim()) === true;
}

/**
 * Merge freshly computed defaults into a capture form's raw values.
 *
 * A field stays under the defaults' control while it is empty or still holds
 * the value the defaults last put there; once the user types something else
 * it is theirs.
 *
 * `mode` says what just changed. `"capture"` (a location was captured or
 * moved) recomputes every controlled field, so moving the point from a GPS
 * fix to a map click clears the accuracy it no longer has. `"input"` (the
 * user edited a field) recomputes only defaults that read other fields, such
 * as a file name built from a site code typed after the capture, and leaves
 * `uuid()` and `now()` alone so an ID does not change on every keystroke.
 *
 * @param form - The capture target's form config.
 * @param values - The form's current raw values.
 * @param autoFilled - What earlier calls filled in, by field.
 * @param context - Variables, geometry and `transform` for the expressions;
 *   `properties` are the form's current values, already coerced.
 * @param mode - What triggered the recompute.
 * @returns The next values (the same object when nothing changed) and the
 *   record to pass as `autoFilled` next time.
 */
export function applyCaptureDefaults(
  form: AttributeFormConfig | undefined,
  values: Record<string, string>,
  autoFilled: Record<string, string>,
  context: QgisExpressionContext & { geometry?: Geometry | null },
  mode: "capture" | "input" = "capture",
): { values: Record<string, string>; autoFilled: Record<string, string> } {
  const refresh = new Set<string>();
  const skip = new Set<string>();
  const kept: Record<string, string> = {};
  for (const field of form?.fields ?? []) {
    const source = field.defaultValue?.trim();
    if (!source) continue;
    const current = values[field.field] ?? "";
    const controlled = current === "" || current === autoFilled[field.field];
    let recompute = controlled;
    if (controlled && mode === "input") {
      const references = qgisExpressionReferences(source);
      recompute = references !== null && !references.volatile && references.fields.length > 0;
    }
    if (recompute) {
      refresh.add(field.field);
    } else {
      skip.add(field.field);
      if (controlled && autoFilled[field.field] !== undefined) {
        kept[field.field] = autoFilled[field.field];
      }
    }
  }
  if (refresh.size === 0) return { values, autoFilled: kept };
  // A value the defaults put there earlier must not feed its own recompute,
  // or a default that became NULL would still be read by the fields after it.
  const properties = { ...context.properties };
  for (const field of refresh) delete properties[field];
  const defaults = computeAttributeFormDefaults(form, { ...context, properties }, { skip });
  let next = values;
  for (const field of refresh) {
    const value = defaults[field] ?? "";
    if ((values[field] ?? "") === value) continue;
    if (next === values) next = { ...values };
    next[field] = value;
  }
  return { values: next, autoFilled: { ...kept, ...defaults } };
}
