// The ASPRS LAS 1.4 standard point classes the annotator assigns.

/** One assignable point class. */
export interface PointClassDefinition {
  /** ASPRS classification code written to the LAS Classification field. */
  code: number;
  /** English name, the fallback for the `classes.<code>` catalog key. */
  name: string;
  /** Swatch colour, matching what the LiDAR control renders for the code. */
  color: [number, number, number];
}

/**
 * ASPRS LAS 1.4 standard classes 0-18. The colours mirror maplibre-gl-lidar's
 * `CLASSIFICATION_COLORS` (not exported from its package root) so a swatch in
 * the panel matches the rendered points; keep them in sync on a bump.
 */
export const ASPRS_CLASSES: readonly PointClassDefinition[] = [
  { code: 0, name: "Created, never classified", color: [128, 128, 128] },
  { code: 1, name: "Unclassified", color: [128, 128, 128] },
  { code: 2, name: "Ground", color: [165, 113, 78] },
  { code: 3, name: "Low vegetation", color: [144, 238, 144] },
  { code: 4, name: "Medium vegetation", color: [34, 139, 34] },
  { code: 5, name: "High vegetation", color: [0, 100, 0] },
  { code: 6, name: "Building", color: [255, 165, 0] },
  { code: 7, name: "Low point (noise)", color: [255, 0, 0] },
  { code: 8, name: "Reserved", color: [128, 128, 128] },
  { code: 9, name: "Water", color: [0, 0, 255] },
  { code: 10, name: "Rail", color: [139, 90, 43] },
  { code: 11, name: "Road surface", color: [128, 128, 128] },
  { code: 12, name: "Reserved", color: [128, 128, 128] },
  { code: 13, name: "Wire - guard", color: [255, 255, 0] },
  { code: 14, name: "Wire - conductor", color: [255, 200, 0] },
  { code: 15, name: "Transmission tower", color: [200, 200, 0] },
  { code: 16, name: "Wire-structure connector", color: [100, 100, 100] },
  { code: 17, name: "Bridge deck", color: [0, 128, 255] },
  { code: 18, name: "High noise", color: [255, 0, 255] },
];

/**
 * Looks up the definition for a class code.
 *
 * @param code - ASPRS classification code.
 * @returns The definition, or a grey "Class N" entry for a non-standard code.
 */
export function classDefinition(code: number): PointClassDefinition {
  return (
    ASPRS_CLASSES.find((entry) => entry.code === code) ?? {
      code,
      name: `Class ${code}`,
      color: [128, 128, 128],
    }
  );
}

/**
 * Counts how many points carry each class code.
 *
 * @param classifications - Per-point class codes.
 * @param count - Number of leading entries to count (defaults to the array length).
 * @returns A map from class code to point count, only for codes present.
 */
export function countClasses(
  classifications: Uint8Array,
  count = classifications.length,
): Map<number, number> {
  const histogram = new Uint32Array(256);
  const limit = Math.min(count, classifications.length);
  for (let i = 0; i < limit; i++) histogram[classifications[i]]++;
  const result = new Map<number, number>();
  for (let code = 0; code < 256; code++) {
    if (histogram[code] > 0) result.set(code, histogram[code]);
  }
  return result;
}
