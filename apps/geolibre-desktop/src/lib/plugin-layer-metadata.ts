/**
 * Validates the optional `metadata` a plugin passes to an `add*Layer` call
 * (#2855) and returns a detached copy safe to store on the layer record.
 *
 * The copy is a JSON round trip, so what lands in the store is exactly what a
 * saved project will hold: functions and `undefined` values drop out instead of
 * living on in the session and vanishing on reload.
 *
 * @param method - The API method name, for the error message.
 * @param value - The plugin-supplied `options.metadata`.
 * @returns The metadata to merge, or `undefined` when none was given.
 * @throws If `value` is not a plain, JSON-serializable object.
 */
export function pluginLayerMetadata(
  method: string,
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  const prototype =
    typeof value === "object" && !Array.isArray(value) ? Object.getPrototypeOf(value) : undefined;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${method}: options.metadata must be a plain object.`);
  }
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    throw new Error(`${method}: options.metadata must be JSON-serializable.`);
  }
}
