import type { OgcProcess } from "./ogc-api-processes";

export type OgcInputDefinition = OgcProcess["inputs"][string];
export type OgcInputKind = "string" | "number" | "integer" | "boolean" | "json";

/** Keep referenced/compound schemas available as JSON instead of guessing their types. */
export function ogcInputSchema(definition: OgcInputDefinition): Record<string, unknown> {
  const value = definition.schema;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function ogcInputKind(definition: OgcInputDefinition): OgcInputKind {
  if (
    definition.maxOccurs === "unbounded" ||
    (typeof definition.maxOccurs === "number" && definition.maxOccurs > 1)
  )
    return "json";
  const type = ogcInputSchema(definition).type;
  return type === "string" || type === "number" || type === "integer" || type === "boolean"
    ? type
    : "json";
}

export function ogcInputText(value: unknown, kind: OgcInputKind): string {
  return kind === "string" && typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
}

/** Populate only advertised defaults; unspecified optional values stay absent. */
export function ogcProcessInputDefaults(process: OgcProcess): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.inputs).flatMap(([key, definition]) => {
      const schema = ogcInputSchema(definition);
      return Object.hasOwn(schema, "default")
        ? [[key, ogcInputText(schema.default, ogcInputKind(definition))]]
        : [];
    }),
  );
}

/** Build typed execution inputs, leaving full JSON Schema validation to the service. */
export function parseOgcProcessInputs(
  process: OgcProcess,
  values: Readonly<Record<string, string>>,
  requireInputs = true,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(process.inputs).flatMap(([key, definition]) => {
      const kind = ogcInputKind(definition);
      const present =
        Object.hasOwn(values, key) && (kind === "string" || values[key].trim() !== "");
      if (!present) {
        if (requireInputs && definition.minOccurs !== 0)
          throw new Error(`Missing process input: ${key}`);
        return [];
      }
      const text = values[key];
      let value: unknown;
      if (kind === "string") value = text;
      else if (kind === "number" || kind === "integer") {
        value = Number(text);
        if (!Number.isFinite(value) || (kind === "integer" && !Number.isInteger(value)))
          throw new Error(`Process input ${key} must be a ${kind}.`);
      } else {
        try {
          value = JSON.parse(text);
        } catch {
          throw new Error(`Process input ${key} must be valid JSON.`);
        }
        if (kind === "boolean" && typeof value !== "boolean")
          throw new Error(`Process input ${key} must be a boolean.`);
      }
      return [[key, value]];
    }),
  );
}
