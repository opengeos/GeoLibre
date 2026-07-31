import type { WhiteboxToolParameter } from "@geolibre/processing";

function datasetParameterKind(dataKind: string, suffix: "in" | "out"): string {
  if (["raster", "vector", "lidar", "file"].includes(dataKind)) {
    return `${dataKind}_${suffix}`;
  }
  return `file_${suffix}`;
}

/**
 * Normalized kind of a Processing tool parameter, which is what the tool form
 * switches its control on (`raster_in` browses a file, `double` gets a number
 * stepper, `bool` a checkbox, and so on).
 *
 * A parameter carries its kind explicitly on the sidecar catalog; the WASM tool
 * manifests instead express it through `schema` (`schema.dataset.kind` plus
 * `io_role`), so both shapes are resolved here.
 *
 * @param param - A tool parameter from either catalog.
 * @returns The parameter kind, defaulting to `"string"` when nothing names one.
 */
export function parameterKind(param: WhiteboxToolParameter): string {
  if (param.kind) return param.kind;
  const schema = param.schema;
  const schemaObject =
    schema && typeof schema === "object" ? (schema as Record<string, unknown>) : {};
  const dataset =
    schemaObject.dataset && typeof schemaObject.dataset === "object"
      ? (schemaObject.dataset as Record<string, unknown>)
      : {};
  const dataKind = String(
    param.data_kind ?? schemaObject.data_kind ?? dataset.kind ?? param.type ?? "",
  ).toLowerCase();
  const role = String(param.io_role ?? schemaObject.kind ?? "").toLowerCase();
  if (role === "input") return datasetParameterKind(dataKind, "in");
  if (role === "output") return datasetParameterKind(dataKind, "out");
  if (dataKind === "bool" || schemaObject.kind === "bool") return "bool";
  if (schemaObject.kind === "enum" || param.options?.length) return "enum";
  if (dataKind === "number" || schemaObject.kind === "scalar") {
    const scalar = String(schemaObject.scalar ?? "").toLowerCase();
    return scalar.includes("int") ? "int" : "double";
  }
  return "string";
}
