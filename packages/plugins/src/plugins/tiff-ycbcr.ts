const DEFAULT_COEFFICIENTS = [0.299, 0.587, 0.114] as const;
const DEFAULT_REFERENCE_BLACK_WHITE = [0, 255, 128, 255, 128, 255] as const;

type NumericArray = ArrayLike<number> | undefined;

function finiteValues(values: NumericArray, length: number): number[] | null {
  if (!values || values.length < length) return null;
  const result = Array.from({ length }, (_, index) => Number(values[index]));
  return result.every(Number.isFinite) ? result : null;
}

/** Convert separate TIFF Y/Cb/Cr planes to RGB using tags 529 and 532. */
export function convertTiffYCbCrToRgb(
  yPlane: ArrayLike<number>,
  cbPlane: ArrayLike<number>,
  crPlane: ArrayLike<number>,
  coefficients?: NumericArray,
  referenceBlackWhite?: NumericArray,
): [Float64Array, Float64Array, Float64Array] {
  const [kr, kg, kb] = finiteValues(coefficients, 3) ?? DEFAULT_COEFFICIENTS;
  const reference = finiteValues(referenceBlackWhite, 6) ?? DEFAULT_REFERENCE_BLACK_WHITE;
  const [blackY, whiteY, blackCb, whiteCb, blackCr, whiteCr] = reference;
  const yRange = whiteY - blackY || 255;
  const cbRange = whiteCb - blackCb || 127;
  const crRange = whiteCr - blackCr || 127;
  const safeKg = kg || DEFAULT_COEFFICIENTS[1];
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
    const g = (y - kr * r - kb * b) / safeKg;
    red[index] = Math.max(0, Math.min(255, r));
    green[index] = Math.max(0, Math.min(255, g));
    blue[index] = Math.max(0, Math.min(255, b));
  }

  return [red, green, blue];
}
