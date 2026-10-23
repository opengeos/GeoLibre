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
    customClasses.get(code) ??
    ASPRS_CLASSES.find((entry) => entry.code === code) ?? {
      code,
      name: `Class ${code}`,
      color: [128, 128, 128],
    }
  );
}

/** Lowest and highest code a custom class may use (ASPRS 19-63 are reserved
 * for future standard classes, 64-255 are user-definable). */
export const CUSTOM_CLASS_MIN = 19;
export const CUSTOM_CLASS_MAX = 255;

/** User-defined classes, by code (saved with the project). */
const customClasses = new Map<number, PointClassDefinition>();

/**
 * Replaces the user-defined classes.
 *
 * @param classes - The classes; entries with an invalid code, empty name or
 *   bad colour are dropped.
 */
export function setCustomClasses(classes: readonly PointClassDefinition[]): void {
  customClasses.clear();
  for (const entry of classes) {
    if (
      Number.isInteger(entry.code) &&
      entry.code >= CUSTOM_CLASS_MIN &&
      entry.code <= CUSTOM_CLASS_MAX &&
      typeof entry.name === "string" &&
      entry.name.trim() &&
      Array.isArray(entry.color) &&
      entry.color.length === 3 &&
      entry.color.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
    ) {
      customClasses.set(entry.code, {
        code: entry.code,
        name: entry.name.trim().slice(0, 64),
        color: [entry.color[0], entry.color[1], entry.color[2]],
      });
    }
  }
}

/**
 * Whether a code is a user-defined class.
 *
 * @param code - The class code.
 * @returns True when a custom class uses the code.
 */
export function isCustomClass(code: number): boolean {
  return customClasses.has(code);
}

/**
 * The user-defined classes, ascending by code.
 *
 * @returns Copies of the classes.
 */
export function getCustomClasses(): PointClassDefinition[] {
  return [...customClasses.values()]
    .sort((a, b) => a.code - b.code)
    .map((entry) => ({ ...entry, color: [...entry.color] as [number, number, number] }));
}

/**
 * Every class the annotator can assign: the ASPRS standard classes followed
 * by the user-defined ones.
 *
 * @returns Class definitions, ascending by code.
 */
export function assignableClasses(): PointClassDefinition[] {
  return [...ASPRS_CLASSES, ...getCustomClasses()];
}

/** Parses `#rrggbb` into an RGB triple (null when malformed). */
export function parseHexColor(text: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text.trim());
  return match ? [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)] : null;
}

/** Formats an RGB triple as `#rrggbb`. */
export function toHexColor([r, g, b]: readonly [number, number, number]): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
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
