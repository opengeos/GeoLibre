import { identifierWords, type WhiteboxToolParameter } from "./sidecar-client";

/**
 * Extension (without the dot) the WASM runner should give a `file_out` file so
 * the tool's own format check passes. Whitebox tools infer a table/report
 * format from the output path's extension, so we honor the extension of the
 * user-chosen output path; when none is present we sniff the intended text
 * format from the parameter's name/description (e.g. an "Output JSON report
 * path."), default a `table` output to CSV, and fall back to an opaque `.dat`.
 *
 * @param param - The output parameter (carries `data_kind`/`schema`).
 * @param requested - The user-chosen output path, if any.
 * @returns A lowercase extension without a leading dot (e.g. `csv`, `json`, `dat`).
 */
export function fileOutputTargetExtension(
  param: WhiteboxToolParameter,
  requested: unknown,
): string {
  if (typeof requested === "string") {
    const match = requested.match(/\.([A-Za-z0-9]+)$/);
    if (match) return match[1].toLowerCase();
  }
  return outputTextFormatHint(param) ?? "dat";
}

/**
 * The text/tabular output format a `file_out` parameter declares through its
 * name, description, or `table` data kind, as a bare extension (`csv`/`html`/
 * `json`/...), or `null` when nothing recognizable is found. Shared by the
 * WASM runner's {@link fileOutputTargetExtension} and the dialog's
 * default-name and download-naming code so the two hint lists cannot drift
 * apart.
 *
 * @param param - The output parameter.
 * @returns A bare extension, or `null` if no text format is implied.
 */
export function outputTextFormatHint(param: WhiteboxToolParameter): string | null {
  // An explicit "<ext> recommended" in the description is the tool author's
  // own guidance and wins over every heuristic below. `excel_to_table`'s
  // output is `data_kind: "table"` but its writer is the generic vector
  // format dispatch (same as GeoParquet/GPKG tools), which has no CSV driver
  // -- defaulting a blank path to ".csv" made the tool reject its own default,
  // the same failure mode as #1074.
  // The capture must start with a letter so a decimal in the prose ("a
  // tolerance of 0.5 recommended") cannot be mistaken for an extension.
  const recommended = (param.description ?? "").match(/\.([a-z][a-z0-9]*)\s+recommended/i);
  if (recommended) return recommended[1].toLowerCase();
  // Split the name into words first: `_` is a word character, so `\bcsv\b`
  // alone never matches inside `output_csv`.
  const nameWords = identifierWords(param.name ?? "").join(" ");
  const hint = `${nameWords} ${param.description ?? ""} ${param.type ?? ""}`;
  if (/\bcsv\b/i.test(hint)) return "csv";
  if (/\bhtml\b/i.test(hint)) return "html";
  if (/\bjson\b/i.test(hint)) return "json";
  const schema =
    param.schema && typeof param.schema === "object"
      ? (param.schema as Record<string, unknown>)
      : {};
  const dataset =
    schema.dataset && typeof schema.dataset === "object"
      ? (schema.dataset as Record<string, unknown>)
      : {};
  const dataKind = String(param.data_kind ?? dataset.kind ?? param.type ?? "").toLowerCase();
  return dataKind === "table" ? "csv" : null;
}
