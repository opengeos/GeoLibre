const DEFAULT_COEFFICIENTS = [0.299, 0.587, 0.114] as const;
const DEFAULT_REFERENCE_BLACK_WHITE = [0, 255, 128, 255, 128, 255] as const;

type NumericArray = ArrayLike<number> | undefined;

function finiteValues(values: NumericArray, length: number): number[] | null {
  if (!values || values.length < length) return null;
  const result = Array.from({ length }, (_, index) => Number(values[index]));
  return result.every(Number.isFinite) ? result : null;
}

function validCoefficients(values: NumericArray): number[] | null {
  const coefficients = finiteValues(values, 3);
  if (!coefficients) return null;
  const [kr, kg, kb] = coefficients;
  const sum = kr + kg + kb;
  return kr >= 0 && kg > 0 && kb >= 0 && kr <= 1 && kg <= 1 && kb <= 1 && Math.abs(sum - 1) <= 1e-6
    ? coefficients
    : null;
}

function validReference(values: NumericArray): number[] | null {
  const reference = finiteValues(values, 6);
  if (!reference) return null;
  return reference[1] > reference[0] && reference[3] > reference[2] && reference[5] > reference[4]
    ? reference
    : null;
}

/** Convert separate TIFF Y/Cb/Cr planes to RGB using tags 529 and 532. */
export function convertTiffYCbCrToRgb(
  yPlane: ArrayLike<number>,
  cbPlane: ArrayLike<number>,
  crPlane: ArrayLike<number>,
  coefficients?: NumericArray,
  referenceBlackWhite?: NumericArray,
): [Float64Array, Float64Array, Float64Array] {
  const [kr, kg, kb] = validCoefficients(coefficients) ?? DEFAULT_COEFFICIENTS;
  const reference = validReference(referenceBlackWhite) ?? DEFAULT_REFERENCE_BLACK_WHITE;
  const [blackY, whiteY, blackCb, whiteCb, blackCr, whiteCr] = reference;
  const yRange = whiteY - blackY;
  const cbRange = whiteCb - blackCb;
  const crRange = whiteCr - blackCr;
  const size = Math.min(yPlane.length, cbPlane.length, crPlane.length);
  const red = new Float64Array(size);
  const green = new Float64Array(size);
  const blue = new Float64Array(size);

  for (let index = 0; index < size; index += 1) {
    const y = ((Number(yPlane[index]) - blackY) * 255) / yRange;
    const cb = ((Number(cbPlane[index]) - blackCb) * 127) / cbRange;
    const cr = ((Number(crPlane[index]) - blackCr) * 127) / crRange;
    const r = y + (2 - 2 * kr) * cr;
    const b = y + (2 - 2 * kb) * cb;
    const g = (y - kr * r - kb * b) / kg;
    red[index] = Math.max(0, Math.min(255, r));
    green[index] = Math.max(0, Math.min(255, g));
    blue[index] = Math.max(0, Math.min(255, b));
  }

  return [red, green, blue];
}
