/**
 * Spectral index catalog and band-math expression builder.
 *
 * A spectral index is a normalized ratio of reflectance bands (NDVI, NDWI, …).
 * Rather than implement a new raster kernel, this module compiles an index +
 * a band layout into the same single-input NumPy/JS band-math expression the
 * raster calculator already evaluates — `rasterCalc` in the browser and the
 * `raster-calc` sidecar script. The Spectral Index tool is therefore a
 * preset-driven front end over the existing calculator.
 *
 * Band numbers are 1-indexed to match the calculator's `A1, A2, …` references
 * and GDAL/rasterio band numbering. Sensor presets supply common band layouts;
 * the "custom" sensor lets the user map bands by hand for arbitrarily stacked
 * GeoTIFFs.
 */

/** Canonical reflectance bands an index formula can reference. */
export type BandName = "blue" | "green" | "red" | "nir" | "swir1" | "swir2";

/** Map of band name to its 1-indexed band number within a raster. */
export type BandLayout = Partial<Record<BandName, number>>;

/** A named spectral index and how to compute it. */
export interface SpectralIndex {
  id: string;
  /** Human-readable name shown in the select. */
  name: string;
  /** Bands the formula references (also drives which inputs the user supplies). */
  bands: BandName[];
  /** Expected value range, for default styling of the output. */
  range: [number, number];
  /** A suggested colormap name for styling the output. */
  colormap: string;
  /**
   * Build the band-math expression. `tok(name)` yields the (scale-applied)
   * token for a band; `p` carries index-specific numeric params (e.g. SAVI L).
   */
  expr: (tok: (name: BandName) => string, p: Record<string, number>) => string;
}

/** A normalized difference `(a - b) / (a + b)`, the shape most indices share. */
function normalizedDifference(a: BandName, b: BandName) {
  return (tok: (name: BandName) => string) => {
    const x = tok(a);
    const y = tok(b);
    return `(${x} - ${y}) / (${x} + ${y})`;
  };
}

/** The built-in spectral indices, in display order. */
export const SPECTRAL_INDICES: SpectralIndex[] = [
  {
    id: "ndvi",
    name: "NDVI (vegetation)",
    bands: ["red", "nir"],
    range: [-1, 1],
    colormap: "RdYlGn",
    expr: normalizedDifference("nir", "red"),
  },
  {
    id: "gndvi",
    name: "GNDVI (green vegetation)",
    bands: ["green", "nir"],
    range: [-1, 1],
    colormap: "RdYlGn",
    expr: normalizedDifference("nir", "green"),
  },
  {
    id: "ndwi",
    name: "NDWI (water, McFeeters)",
    bands: ["green", "nir"],
    range: [-1, 1],
    colormap: "Blues",
    expr: normalizedDifference("green", "nir"),
  },
  {
    id: "ndmi",
    name: "NDMI (moisture)",
    bands: ["nir", "swir1"],
    range: [-1, 1],
    colormap: "BrBG",
    expr: normalizedDifference("nir", "swir1"),
  },
  {
    id: "ndbi",
    name: "NDBI (built-up)",
    bands: ["nir", "swir1"],
    range: [-1, 1],
    colormap: "RdBu",
    expr: normalizedDifference("swir1", "nir"),
  },
  {
    id: "nbr",
    name: "NBR (burn ratio)",
    bands: ["nir", "swir2"],
    range: [-1, 1],
    colormap: "RdYlGn",
    expr: normalizedDifference("nir", "swir2"),
  },
  {
    id: "evi",
    name: "EVI (enhanced vegetation)",
    bands: ["blue", "red", "nir"],
    range: [-1, 1],
    colormap: "RdYlGn",
    // EVI's additive constants assume surface reflectance (0–1); set the scale
    // factor for integer-DN imagery (e.g. 0.0001 for Sentinel-2 L2A).
    expr: (tok) => {
      const nir = tok("nir");
      const red = tok("red");
      const blue = tok("blue");
      return `2.5 * ((${nir} - ${red}) / (${nir} + 6 * ${red} - 7.5 * ${blue} + 1))`;
    },
  },
  {
    id: "savi",
    name: "SAVI (soil-adjusted vegetation)",
    bands: ["red", "nir"],
    range: [-1, 1],
    colormap: "RdYlGn",
    expr: (tok, p) => {
      const nir = tok("nir");
      const red = tok("red");
      const L = p.L ?? 0.5;
      return `((${nir} - ${red}) / (${nir} + ${red} + ${L})) * (1 + ${L})`;
    },
  },
];

/** Look up an index by id. */
export function getSpectralIndex(id: string): SpectralIndex | undefined {
  return SPECTRAL_INDICES.find((index) => index.id === id);
}

/**
 * Built-in sensor band layouts. Band numbers follow the most common
 * surface-reflectance stack order for each sensor; they are editable via the
 * "custom" sensor when a file is stacked differently.
 */
export const SENSOR_PRESETS: Record<(typeof SENSOR_IDS)[number], BandLayout> = {
  // Sentinel-2 6-band reflectance stack [B2, B3, B4, B8, B11, B12].
  sentinel2: { blue: 1, green: 2, red: 3, nir: 4, swir1: 5, swir2: 6 },
  // Landsat 8/9 (OLI) Collection 2 surface reflectance bands B1–B7.
  landsat89: { blue: 2, green: 3, red: 4, nir: 5, swir1: 6, swir2: 7 },
  // NAIP 4-band imagery (no SWIR bands).
  naip: { red: 1, green: 2, blue: 3, nir: 4 },
  custom: {},
};

/** Sensor ids that ship with a preset, in display order. */
export const SENSOR_IDS = ["sentinel2", "landsat89", "naip", "custom"] as const;

/** Result of compiling a spectral index for an engine. */
export interface BuiltSpectralIndex {
  /** The band-math expression over `A1, A2, …`. */
  expression: string;
  /** The 1-indexed band numbers the expression references. */
  bands: number[];
  index: SpectralIndex;
}

function asNumber(value: unknown): number | undefined {
  if (value === "" || value == null) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Resolve the 1-indexed band number for a band name from tool parameters. */
function resolveBand(name: BandName, sensor: string, params: Record<string, unknown>): number {
  // Preset sensors always use their preset band layout; only the Custom sensor
  // reads the manual band-number params. (Mixing the two would let a stale
  // hidden custom value override a freshly selected preset.)
  const preset = SENSOR_PRESETS[sensor as (typeof SENSOR_IDS)[number]];
  const band = sensor === "custom" ? asNumber(params[name]) : preset?.[name];
  if (band == null) {
    throw new Error(
      sensor === "custom"
        ? `Band "${name}" is required for this index — enter a band number above.`
        : `The ${sensor} preset does not include the "${name}" band this index needs. ` +
            `Switch to a sensor that has it, or select Custom to enter a band number.`,
    );
  }
  if (!Number.isInteger(band) || band < 1) {
    throw new Error(`Band "${name}" must be a whole number ≥ 1 (got ${band}).`);
  }
  return band;
}

/**
 * Compile a spectral index into a band-math expression from the tool's
 * parameters (`index`, `sensor`, per-band numbers, `scale`, and index-specific
 * knobs such as SAVI `L`). Throws a user-facing error if a required band is
 * missing or invalid.
 */
export function buildSpectralIndexExpression(params: Record<string, unknown>): BuiltSpectralIndex {
  const indexId = String(params.index ?? "");
  const index = getSpectralIndex(indexId);
  if (!index) throw new Error(`Unknown spectral index: "${indexId}".`);

  const sensor = String(params.sensor ?? "custom");
  const scale = asNumber(params.scale) ?? 1;
  if (scale <= 0) throw new Error("Reflectance scale must be greater than 0.");

  const used: number[] = [];
  const tok = (name: BandName): string => {
    const band = resolveBand(name, sensor, params);
    if (!used.includes(band)) used.push(band);
    // When scale=1, s*A = A so we emit the bare reference. When scale != 1 we
    // wrap every band uniformly — for ratio indices the scale cancels anyway;
    // for EVI/SAVI the additive constants require true reflectance values.
    return scale === 1 ? `A${band}` : `(${scale} * A${band})`;
  };

  const numericParams: Record<string, number> = {};
  const L = asNumber(params.L);
  if (L !== undefined) numericParams.L = L;

  const expression = index.expr(tok, numericParams);
  return { expression, bands: used, index };
}
