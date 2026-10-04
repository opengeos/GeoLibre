import {
  identifierWords,
  isMultipleWhiteboxDatasetParameter,
  type WhiteboxToolParameter,
} from "@geolibre/processing";

// Re-exported so the dialog helpers keep one import site for parameter
// classification; the implementation is shared with the WASM runner.
export { identifierWords };

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

/** Whether a dataset input accepts a stack/list rather than one dataset. */
export function isMultipleDatasetParameter(param: WhiteboxToolParameter): boolean {
  return parameterKind(param).endsWith("_in") && isMultipleWhiteboxDatasetParameter(param);
}

/**
 * Whether a path parameter names a folder, so its browse button opens a folder
 * picker (desktop) and skips the read-a-file fallback (web).
 *
 * A typed dataset parameter (`raster_in`, `file_out`, …) is a file unless a
 * segment of its own name is `folder` or `directory` (`output_directory`). Its
 * description is not consulted: many LiDAR inputs read "If omitted, runs in
 * batch mode over LiDAR files in current directory", and matching that made
 * every such browse button do nothing in the browser (and open a folder picker
 * on desktop). The `dir` abbreviation is left out of the name rule because
 * hydrology tools use it for flow *direction* (`flow_dir_output_path`). An
 * untyped parameter has only its wording to go on, so the description still
 * counts there, as does a `folder`/`directory` word of a snake_case, kebab-case
 * or camelCase name (`output_folder`).
 *
 * @param param - A tool parameter from either catalog.
 * @returns True when the parameter expects a directory path.
 */
export function isDirectoryParameter(param: WhiteboxToolParameter): boolean {
  const namedFolder = identifierWords(param.name ?? "").some((word) => FOLDER_NAME_WORDS.has(word));
  if (/^(raster|vector|lidar|file)_(in|out)$/.test(parameterKind(param))) return namedFolder;
  if (namedFolder) return true;
  const text = `${param.name} ${param.description ?? ""} ${param.type ?? ""}`.toLowerCase();
  return /\b(folder|directory|dir)\b/.test(text);
}

// Name words that mark a parameter as a folder. `dir` counts only as a whole
// name (`dir`), never as one word of a longer one: hydrology tools use it for
// flow *direction* (`flow_dir`).
const FOLDER_NAME_WORDS = new Set(["folder", "directory"]);
