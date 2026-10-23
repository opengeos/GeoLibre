/**
 * Collapse a project importer's per-layer warnings into one entry per distinct
 * message.
 *
 * A real ArcGIS Pro or QGIS project can carry hundreds of layers that all fail
 * for the same reason (GeoLibre#1904: 257 layers, every one of them "The
 * layer's data format is not supported"). Listing one line per layer buries
 * that single root cause in a list nobody can read, so the dialog groups by the
 * message the user would actually see.
 */

/** The fields the QGIS and ArcGIS Pro importer warnings have in common. */
export interface ImportWarningLike {
  layerName: string;
  reason: string;
}

export interface ImportWarningGroup {
  /** The rendered message shared by every warning in the group. */
  message: string;
  /** Every affected layer name, in the order the importer reported them. */
  layerNames: string[];
}

/**
 * Group import warnings by their rendered message, most affected first.
 *
 * Grouping on the rendered message rather than on `reason` matters because
 * several reasons interpolate a layer type or provider into the text: keying on
 * `reason` alone would merge "The CIMRasterLayer layer type is not supported"
 * with "The CIMSceneLayer layer type is not supported", and keying on
 * `reason` plus those fields would split one "format" message into visually
 * identical groups. The message is what the user reads, so it is what decides
 * whether two warnings are the same warning.
 *
 * @param warnings - The importer's warnings, in report order.
 * @param describe - Renders a warning's localized message.
 * @returns Groups sorted by descending layer count, ties broken by first
 *   appearance so the list is stable across renders.
 */
export function groupImportWarnings<T extends ImportWarningLike>(
  warnings: readonly T[],
  describe: (warning: T) => string,
): ImportWarningGroup[] {
  const groups = new Map<string, ImportWarningGroup>();
  for (const warning of warnings) {
    const message = describe(warning);
    const existing = groups.get(message);
    if (existing) {
      existing.layerNames.push(warning.layerName);
    } else {
      groups.set(message, { message, layerNames: [warning.layerName] });
    }
  }
  // Map iteration is insertion-ordered and Array#sort is stable, so equal
  // counts keep the order the importer reported them in.
  return [...groups.values()].sort((a, b) => b.layerNames.length - a.layerNames.length);
}
