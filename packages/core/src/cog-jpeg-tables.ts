// JPEG-in-TIFF tiles that omit their own tables (TIFF tag 347 holds them), which
// cog-tiler-wasm's decoder rejects as "use of unset quantization table". Every
// engine that opens a COG through the tiler (the MapLibre raster control, the
// Cesium globe, the ArcGIS view) wraps its `openCog` with {@link
// withJpegTablesPatch} so those tiles decode through geotiff.js instead.

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

/**
 * Whether a cog-tiler-wasm level's `compression` is baseline JPEG, the only
 * codec whose tiles may omit their tables (TIFF tag 347) and so need the
 * geotiff.js window read in {@link patchJpegCogSource}. The string is whitebox-wasm's
 * enum name, so match `Jpeg`/`OldJpeg` exactly: a looser `/jpeg/i` would also
 * catch `JpegXl`, which the wasm decoder handles and geotiff.js cannot decode
 * at all (#2339).
 */
export function isAbbreviatedJpegCompression(compression: string | undefined): boolean {
  return /^(old)?jpeg$/i.test(compression ?? "");
}

type GeoTiffImage = {
  fileDirectory?: {
    PhotometricInterpretation?: number;
    getValue?: (tag: number) => unknown;
    hasTag?: (tag: number) => boolean;
    loadValue?: (tag: number) => Promise<unknown>;
  };
  readRasters: (options: {
    window: [number, number, number, number];
  }) => Promise<ArrayLike<ArrayLike<number>>>;
};
type CogSourceInternals = {
  levels?: Array<{ compression?: string }>;
  tiff?: unknown;
  _tiffImage?: (level: number) => Promise<GeoTiffImage>;
  _assembleWindow?: (
    level: number,
    x: number,
    y: number,
    width: number,
    height: number,
    band?: number,
  ) => Promise<ArrayLike<number>>;
  geolibreJpegTablesPatched?: boolean;
};

/**
 * Route an abbreviated-JPEG COG's tile windows through geotiff.js, which reads
 * the shared tables, converting Y/Cb/Cr to the RGB bands the renderers expect.
 * Any other source is returned unchanged.
 *
 * @param source - A cog-tiler-wasm source.
 * @returns The same source, patched in place when it needs it.
 */
export function patchJpegCogSource(source: unknown): unknown {
  const cog = source as CogSourceInternals;
  if (
    cog.geolibreJpegTablesPatched ||
    !isAbbreviatedJpegCompression(cog.levels?.[0]?.compression) ||
    !cog.tiff ||
    !cog._tiffImage ||
    !cog._assembleWindow
  ) {
    return source;
  }

  const windowCache = new Map<string, Promise<ArrayLike<ArrayLike<number>>>>();
  cog._assembleWindow = async (level, x, y, width, height, band = 0) => {
    const key = `${level}/${x}/${y}/${width}/${height}`;
    let decoded = windowCache.get(key);
    if (!decoded) {
      decoded = cog._tiffImage!(level).then(async (image) => {
        const rasters = await image.readRasters({
          window: [x, y, x + width, y + height],
        });
        // geotiff.js expands the chroma subsampling but deliberately returns
        // the TIFF's native Y/Cb/Cr samples. The renderer expects RGB bands,
        // like the GPU engine, so perform the TIFF/JPEG color transform once
        // for the shared three-band window.
        const photometric =
          image.fileDirectory?.PhotometricInterpretation ?? image.fileDirectory?.getValue?.(262);
        if (photometric !== 6 || rasters.length < 3) {
          return rasters;
        }
        const directory = image.fileDirectory;
        const readTag = async (tag: number): Promise<ArrayLike<number> | undefined> => {
          if (directory?.hasTag?.(tag) === false) return undefined;
          const value = directory?.loadValue
            ? await directory.loadValue(tag)
            : directory?.getValue?.(tag);
          return value as ArrayLike<number> | undefined;
        };
        const [coefficients, referenceBlackWhite] = await Promise.all([readTag(529), readTag(532)]);
        return convertTiffYCbCrToRgb(
          rasters[0],
          rasters[1],
          rasters[2],
          coefficients,
          referenceBlackWhite,
        );
      });
      windowCache.set(key, decoded);
      void decoded.catch(() => {
        if (windowCache.get(key) === decoded) windowCache.delete(key);
      });
      if (windowCache.size > 32) windowCache.delete(windowCache.keys().next().value!);
    }
    const rasters = await decoded;
    return rasters[band] ?? rasters[0];
  };
  cog.geolibreJpegTablesPatched = true;
  return source;
}

/**
 * A cog-tiler module whose `openCog` returns {@link patchJpegCogSource}-patched
 * sources; the rest of the module is passed through.
 *
 * @param module - The cog-tiler-wasm module (or a test double).
 * @returns The wrapped module.
 */
export function withJpegTablesPatch<M extends { openCog: (input: never) => Promise<unknown> }>(
  module: M,
): M {
  return {
    ...module,
    openCog: (async (input: never) =>
      patchJpegCogSource(await module.openCog(input))) as M["openCog"],
  };
}
