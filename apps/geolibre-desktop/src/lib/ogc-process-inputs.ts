import { OgcProcessError } from "./ogc-process-errors";
import type { OgcProcess } from "./ogc-api-processes";
import { MAX_PROCESS_INPUT_BYTES } from "./ogc-process-limits";

/** Serialize layer inputs with an early lower-bound limit and an exact final UTF-8 check. */
export function serializeOgcProcessLayerInput(value: unknown): string | null {
  const exceeded = new RangeError("Process input limit");
  let bytes = 0;
  const add = (count: number) => {
    bytes += count;
    if (bytes > MAX_PROCESS_INPUT_BYTES) throw exceeded;
  };
  const string = (text: string) => {
    add(2);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code < 32) add([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
      else if (code === 34 || code === 92) add(2);
      else if (code < 128) add(1);
      else if (code < 2048) add(2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          add(4);
          index++;
        } else add(6);
      } else add(code >= 0xdc00 && code <= 0xdfff ? 6 : 3);
    }
  };
  let root = true;
  try {
    const serialized = JSON.stringify(value, function (this: unknown, key, item: unknown) {
      if (item instanceof String) item = String(item);
      else if (item instanceof Number) item = Number(item);
      else if (item instanceof Boolean) item = Boolean.prototype.valueOf.call(item);
      const omitted = item === undefined || typeof item === "function" || typeof item === "symbol";
      // The replacer sees toJSON's result. Omitted object properties must not
      // count toward the bound; undefined array items serialize as null.
      if (!root && !Array.isArray(this) && !omitted) string(key);
      root = false;
      if (omitted) {
        if (Array.isArray(this)) add(4);
      } else if (typeof item === "string") string(item);
      else if (item === null) add(4);
      else if (typeof item === "object") add(2);
      else if (typeof item === "boolean") add(item ? 4 : 5);
      else if (typeof item === "number") add(Number.isFinite(item) ? String(item).length : 4);
      return item;
    });
    // Commas/colons are excluded above so the early bound never rejects valid
    // input. The partial serializer stays bounded; enforce the exact wire size.
    return serialized !== undefined &&
      new TextEncoder().encode(serialized).byteLength <= MAX_PROCESS_INPUT_BYTES
      ? serialized
      : null;
  } catch (error) {
    if (error === exceeded) return null;
    throw error;
  }
}

export type OgcInputDefinition = OgcProcess["inputs"][string];
export type OgcInputKind = "string" | "number" | "integer" | "boolean" | "json";

/** Keep referenced/compound schemas available as JSON instead of guessing their types. */
export function ogcInputSchema(definition: OgcInputDefinition): Record<string, unknown> {
  const value = definition.schema;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isRepeatedInput(definition: OgcInputDefinition): boolean {
  return (
    definition.maxOccurs === "unbounded" ||
    (typeof definition.maxOccurs === "number" && definition.maxOccurs > 1)
  );
}

export function ogcInputKind(definition: OgcInputDefinition): OgcInputKind {
  if (isRepeatedInput(definition)) return "json";
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
      if (schema.default === null) {
        const type = schema.type;
        const excludesNull =
          typeof type === "string"
            ? type !== "null"
            : Array.isArray(type) && !type.includes("null");
        if (excludesNull || ogcInputKind(definition) !== "json") return [];
      }
      const value =
        schema.default && typeof schema.default === "object" && !Array.isArray(schema.default)
          ? { value: schema.default }
          : schema.default;
      return Object.hasOwn(schema, "default")
        ? [
            [
              key,
              ogcInputText(isRepeatedInput(definition) ? [value] : value, ogcInputKind(definition)),
            ],
          ]
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
