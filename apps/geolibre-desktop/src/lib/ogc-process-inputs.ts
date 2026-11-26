import { OgcProcessError } from "./ogc-process-errors";
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

/** Keep protocol references in JSON mode when a literal control cannot represent them. */
export function ogcInputFieldText(value: unknown, kind: OgcInputKind): string {
  const representable =
    kind === "json" ||
    (kind === "string" && typeof value === "string") ||
    (kind === "boolean" && typeof value === "boolean") ||
    ((kind === "number" || kind === "integer") &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      (kind !== "integer" || Number.isInteger(value)));
  if (!representable) throw new OgcProcessError("inputRepresentation");
  return ogcInputText(value, kind);
}

/** Populate only advertised defaults; unspecified optional values stay absent. */
export function ogcProcessInputDefaults(process: OgcProcess): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.inputs).flatMap(([key, definition]) => {
      const schema = ogcInputSchema(definition);
      if (schema.default === null && ogcInputKind(definition) !== "json") return [];
      const value =
        schema.default && typeof schema.default === "object" && !Array.isArray(schema.default)
          ? { value: schema.default }
          : schema.default;
      return Object.hasOwn(schema, "default")
        ? [[key, ogcInputText(value, ogcInputKind(definition))]]
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
          throw new OgcProcessError("missingInput", { name: key });
        return [];
      }
      const text = values[key];
      let value: unknown;
      if (kind === "string") value = text;
      else if (kind === "number" || kind === "integer") {
        value = Number(text);
        if (!Number.isFinite(value) || (kind === "integer" && !Number.isInteger(value)))
          throw new OgcProcessError(kind === "integer" ? "inputInteger" : "inputNumber", {
            name: key,
          });
      } else {
        try {
          value = JSON.parse(text);
        } catch {
          throw new OgcProcessError("inputJson", { name: key });
        }
        if (kind === "boolean" && typeof value !== "boolean")
          throw new OgcProcessError("inputBoolean", { name: key });
      }
      return [[key, value]];
    }),
  );
}
