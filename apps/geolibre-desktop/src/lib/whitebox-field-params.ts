// Name-based rules for the Processing toolbox's attribute-field parameters.
//
// Many Whitebox/GeoLibre tools take a column name as a plain string parameter
// (`points_to_line`'s `line_field`/`sort_field`, and ~170 others). The dialog
// renders those as free text, so the user has to recall a column name exactly
// (GeoLibre#1459). These helpers recognize such a parameter and work out which
// of the tool's vector inputs supplies its column names, purely from parameter
// names — no per-tool table to keep in sync with the catalog.

/**
 * Suffix that marks a parameter as naming an attribute column: `field`,
 * `fields`, `attribute` or `attributes`, either as the whole name or after an
 * underscore.
 */
export const FIELD_PARAM_SUFFIX = /(^|_)(fields?|attributes?)$/i;

/**
 * Whether a parameter name reads as an attribute-column name.
 *
 * Callers must also check the parameter is a scalar string: the sidecar's
 * catalog exposes `classify_objects_svm`'s `class_field` as a *dataset* input,
 * and a dataset parameter names a file, not a column. (The WASM manifests used
 * to mistype ~40 of these the same way, `dissolve_field` among them, until
 * opengeos/whitebox-wasm#19 taught the manifest inference that a `*_field` name
 * is a column; the sidecar catalog still carries a few.)
 *
 * @param name - The tool parameter's name.
 * @returns `true` when the name ends in a field/attribute suffix.
 */
export function isFieldParameterName(name: string): boolean {
  return FIELD_PARAM_SUFFIX.test(name);
}

/**
 * The vector input whose layer supplies a field parameter's column names, for a
 * tool that has more than one. Matched on the longest leading name segment, so
 * `target_match_field` resolves to `target` rather than to the first input, and
 * a plural input name is tolerated (`origin_id_field` → `origins`).
 *
 * Returns `undefined` when nothing matches (`compare_fields` against
 * `update`/`base`); the caller then offers every selected input's columns
 * rather than guessing one, so the right column is still in the list.
 *
 * @param fieldParamName - The field parameter's name.
 * @param vectorInputNames - The tool's vector-input parameter names, in order.
 * @returns The matching input name, or `undefined`.
 */
export function fieldSourceInputName(
  fieldParamName: string,
  vectorInputNames: string[],
): string | undefined {
  const tokens = fieldParamName.replace(FIELD_PARAM_SUFFIX, "").split("_").filter(Boolean);
  for (let count = tokens.length; count > 0; count -= 1) {
    const prefix = tokens.slice(0, count).join("_");
    const match = vectorInputNames.find((name) => name === prefix || name === `${prefix}s`);
    if (match) return match;
  }
  return undefined;
}
