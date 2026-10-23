// Colour-vision-deficiency (CVD) simulation for the View → Color vision
// preview. Each mode is a 3×3 RGB matrix rendered as an SVG `feColorMatrix`
// filter that CSS applies to the map's canvases (see `CvdPreview.tsx`).
//
// Protanopia, deuteranopia and tritanopia use the full-severity (1.0) matrices
// from Machado, Oliveira & Fernandes, "A Physiologically-based Model for
// Simulation of Color Vision Deficiency", IEEE TVCG 15(6), 2009,
// doi:10.1109/TVCG.2009.113 (table published at
// https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/CVD_Simulation.html).
// Machado's model covers anomalous trichromacy and dichromacy only, so
// achromatopsia (rod monochromacy) is modelled as relative luminance with the
// ITU-R BT.709 coefficients, the usual simulation for total colour blindness.
//
// All four matrices are defined on linear RGB. The filter therefore sets
// `color-interpolation-filters="linearRGB"` so the browser linearizes the
// sRGB pixels before the matrix and re-encodes after it.

/** The simulated colour-vision deficiencies, in menu order. */
export const CVD_MODES = ["protanopia", "deuteranopia", "tritanopia", "achromatopsia"] as const;

export type CvdMode = (typeof CVD_MODES)[number];

/** A row-major 3×3 matrix mapping linear RGB to simulated linear RGB. */
export type RgbMatrix = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

const BT709_LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/** Simulation matrices per mode (see the module comment for sources). */
export const CVD_MATRICES: Readonly<Record<CvdMode, RgbMatrix>> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
  achromatopsia: [BT709_LUMA, BT709_LUMA, BT709_LUMA],
};

/**
 * Type guard for a CVD mode string.
 *
 * @param value Any value, e.g. a menu radio value.
 *
 * @returns True when `value` is one of {@link CVD_MODES}.
 */
export function isCvdMode(value: unknown): value is CvdMode {
  return typeof value === "string" && (CVD_MODES as readonly string[]).includes(value);
}

/**
 * Build the `values` attribute of an SVG `feColorMatrix type="matrix"` for a
 * 3×3 RGB matrix: four rows of five numbers (R, G, B, A, offset), with alpha
 * passed through unchanged and no offsets.
 *
 * @param matrix The row-major 3×3 RGB matrix.
 *
 * @returns The 20 space-separated values.
 */
export function colorMatrixValues(matrix: RgbMatrix): string {
  const rows = matrix.map((row) => [...row, 0, 0]);
  rows.push([0, 0, 0, 1, 0]);
  return rows.map((row) => row.join(" ")).join(" ");
}

/**
 * The `feColorMatrix` values for a CVD mode.
 *
 * @param mode The deficiency to simulate.
 *
 * @returns The 20 space-separated matrix values.
 */
export function cvdColorMatrixValues(mode: CvdMode): string {
  return colorMatrixValues(CVD_MATRICES[mode]);
}

/**
 * The DOM id of the SVG filter element for a CVD mode, referenced from CSS as
 * `filter: url(#<id>)`.
 *
 * @param mode The deficiency to simulate.
 *
 * @returns A document-unique element id.
 */
export function cvdFilterId(mode: CvdMode): string {
  return `geolibre-cvd-${mode}`;
}

/**
 * Apply a simulation matrix to one linear-RGB colour. Used by tests to check
 * the matrices behave (white stays white, protan/deutan confuse red and green).
 *
 * @param matrix The row-major 3×3 RGB matrix.
 * @param rgb A linear RGB triplet, components in [0, 1].
 *
 * @returns The simulated linear RGB triplet (unclamped).
 */
export function applyRgbMatrix(
  matrix: RgbMatrix,
  rgb: readonly [number, number, number],
): [number, number, number] {
  const [r, g, b] = rgb;
  return matrix.map((row) => row[0] * r + row[1] * g + row[2] * b) as [number, number, number];
}
