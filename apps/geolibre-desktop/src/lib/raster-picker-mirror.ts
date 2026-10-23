/**
 * Hand-kept copies of the small, synchronous picker data `maplibre-gl-raster`
 * exports: the colormap list and the normalized-difference index presets.
 *
 * The style panels need these the moment they render, but importing even one
 * constant from the package pulls its whole ~0.35 MB chunk onto the startup
 * path, since the package bundles everything into one shared file. Everything
 * else the app takes from the package (GeoTIFF reads, stats, the control) is
 * async and imports it on demand.
 *
 * Copied from maplibre-gl-raster 0.14.15.
 * `tests/raster-picker-mirror.test.ts` compares each value with the package
 * export, so a change upstream fails `npm run test:frontend`. See
 * docs/maintenance.md.
 */
import type { ColormapOption, NormalizedDifferenceIndex } from "maplibre-gl-raster";

/** Picker-ready colormaps: renderer name, display label, and sprite row. */
export const COLORMAP_OPTIONS: readonly ColormapOption[] = [
  { name: "accent", label: "Accent", rowIndex: 0 },
  { name: "afmhot", label: "afmhot", rowIndex: 1 },
  { name: "algae", label: "algae", rowIndex: 2 },
  { name: "amp", label: "amp", rowIndex: 3 },
  { name: "autumn", label: "autumn", rowIndex: 4 },
  { name: "balance", label: "balance", rowIndex: 5 },
  { name: "binary", label: "binary", rowIndex: 6 },
  { name: "blues", label: "Blues", rowIndex: 7 },
  { name: "bone", label: "bone", rowIndex: 8 },
  { name: "brbg", label: "BrBG", rowIndex: 9 },
  { name: "brg", label: "brg", rowIndex: 10 },
  { name: "bugn", label: "BuGn", rowIndex: 11 },
  { name: "bupu", label: "BuPu", rowIndex: 12 },
  { name: "bwr", label: "bwr", rowIndex: 13 },
  { name: "cfastie", label: "cfastie", rowIndex: 14 },
  { name: "cividis", label: "cividis", rowIndex: 15 },
  { name: "cmrmap", label: "CMRmap", rowIndex: 16 },
  { name: "cool", label: "cool", rowIndex: 17 },
  { name: "coolwarm", label: "coolwarm", rowIndex: 18 },
  { name: "copper", label: "copper", rowIndex: 19 },
  { name: "cubehelix", label: "cubehelix", rowIndex: 20 },
  { name: "curl", label: "curl", rowIndex: 21 },
  { name: "dark2", label: "Dark2", rowIndex: 22 },
  { name: "deep", label: "deep", rowIndex: 23 },
  { name: "delta", label: "delta", rowIndex: 24 },
  { name: "dense", label: "dense", rowIndex: 25 },
  { name: "diff", label: "diff", rowIndex: 26 },
  { name: "flag", label: "flag", rowIndex: 27 },
  { name: "gist_earth", label: "gist_earth", rowIndex: 28 },
  { name: "gist_gray", label: "gist_gray", rowIndex: 29 },
  { name: "gist_heat", label: "gist_heat", rowIndex: 30 },
  { name: "gist_ncar", label: "gist_ncar", rowIndex: 31 },
  { name: "gist_rainbow", label: "gist_rainbow", rowIndex: 32 },
  { name: "gist_stern", label: "gist_stern", rowIndex: 33 },
  { name: "gist_yarg", label: "gist_yarg", rowIndex: 34 },
  { name: "gnbu", label: "GnBu", rowIndex: 35 },
  { name: "gnuplot", label: "gnuplot", rowIndex: 36 },
  { name: "gnuplot2", label: "gnuplot2", rowIndex: 37 },
  { name: "gray", label: "gray", rowIndex: 38 },
  { name: "greens", label: "Greens", rowIndex: 39 },
  { name: "greys", label: "Greys", rowIndex: 40 },
  { name: "haline", label: "haline", rowIndex: 41 },
  { name: "hot", label: "hot", rowIndex: 42 },
  { name: "hsv", label: "hsv", rowIndex: 43 },
  { name: "ice", label: "ice", rowIndex: 44 },
  { name: "inferno", label: "inferno", rowIndex: 45 },
  { name: "jet", label: "jet", rowIndex: 46 },
  { name: "magma", label: "magma", rowIndex: 47 },
  { name: "matter", label: "matter", rowIndex: 48 },
  { name: "nipy_spectral", label: "nipy_spectral", rowIndex: 49 },
  { name: "ocean", label: "ocean", rowIndex: 50 },
  { name: "oranges", label: "Oranges", rowIndex: 51 },
  { name: "orrd", label: "OrRd", rowIndex: 52 },
  { name: "oxy", label: "oxy", rowIndex: 53 },
  { name: "paired", label: "Paired", rowIndex: 54 },
  { name: "pastel1", label: "Pastel1", rowIndex: 55 },
  { name: "pastel2", label: "Pastel2", rowIndex: 56 },
  { name: "phase", label: "phase", rowIndex: 57 },
  { name: "pink", label: "pink", rowIndex: 58 },
  { name: "piyg", label: "PiYG", rowIndex: 59 },
  { name: "plasma", label: "plasma", rowIndex: 60 },
  { name: "prgn", label: "PRGn", rowIndex: 61 },
  { name: "prism", label: "prism", rowIndex: 62 },
  { name: "pubu", label: "PuBu", rowIndex: 63 },
  { name: "pubugn", label: "PuBuGn", rowIndex: 64 },
  { name: "puor", label: "PuOr", rowIndex: 65 },
  { name: "purd", label: "PuRd", rowIndex: 66 },
  { name: "purples", label: "Purples", rowIndex: 67 },
  { name: "rain", label: "rain", rowIndex: 68 },
  { name: "rainbow", label: "rainbow", rowIndex: 69 },
  { name: "rdbu", label: "RdBu", rowIndex: 70 },
  { name: "rdgy", label: "RdGy", rowIndex: 71 },
  { name: "rdpu", label: "RdPu", rowIndex: 72 },
  { name: "rdylbu", label: "RdYlBu", rowIndex: 73 },
  { name: "rdylgn", label: "RdYlGn", rowIndex: 74 },
  { name: "reds", label: "Reds", rowIndex: 75 },
  { name: "rplumbo", label: "rplumbo", rowIndex: 76 },
  { name: "schwarzwald", label: "schwarzwald", rowIndex: 77 },
  { name: "seismic", label: "seismic", rowIndex: 78 },
  { name: "set1", label: "Set1", rowIndex: 79 },
  { name: "set2", label: "Set2", rowIndex: 80 },
  { name: "set3", label: "Set3", rowIndex: 81 },
  { name: "solar", label: "solar", rowIndex: 82 },
  { name: "spectral", label: "Spectral", rowIndex: 83 },
  { name: "speed", label: "speed", rowIndex: 84 },
  { name: "spring", label: "spring", rowIndex: 85 },
  { name: "summer", label: "summer", rowIndex: 86 },
  { name: "tab10", label: "tab10", rowIndex: 87 },
  { name: "tab20", label: "tab20", rowIndex: 88 },
  { name: "tab20b", label: "tab20b", rowIndex: 89 },
  { name: "tab20c", label: "tab20c", rowIndex: 90 },
  { name: "tarn", label: "tarn", rowIndex: 91 },
  { name: "tempo", label: "tempo", rowIndex: 92 },
  { name: "terrain", label: "terrain", rowIndex: 93 },
  { name: "thermal", label: "thermal", rowIndex: 94 },
  { name: "topo", label: "topo", rowIndex: 95 },
  { name: "turbid", label: "turbid", rowIndex: 96 },
  { name: "turbo", label: "turbo", rowIndex: 97 },
  { name: "twilight", label: "twilight", rowIndex: 98 },
  { name: "twilight_shifted", label: "twilight_shifted", rowIndex: 99 },
  { name: "viridis", label: "viridis", rowIndex: 100 },
  { name: "winter", label: "winter", rowIndex: 101 },
  { name: "wistia", label: "Wistia", rowIndex: 102 },
  { name: "ylgn", label: "YlGn", rowIndex: 103 },
  { name: "ylgnbu", label: "YlGnBu", rowIndex: 104 },
  { name: "ylorbr", label: "YlOrBr", rowIndex: 105 },
  { name: "ylorrd", label: "YlOrRd", rowIndex: 106 },
];

/** Built-in normalized-difference index presets, in menu order. */
export const NORMALIZED_DIFFERENCE_INDICES: readonly NormalizedDifferenceIndex[] = [
  {
    id: "ndvi",
    label: "NDVI",
    name: "Normalized Difference Vegetation Index — (NIR - Red) / (NIR + Red)",
    roleA: "NIR",
    roleB: "Red",
    colormap: "rdylgn",
  },
  {
    id: "ndwi",
    label: "NDWI",
    name: "Normalized Difference Water Index — (Green - NIR) / (Green + NIR)",
    roleA: "Green",
    roleB: "NIR",
    colormap: "blues",
  },
  {
    id: "ndmi",
    label: "NDMI",
    name: "Normalized Difference Moisture Index — (NIR - SWIR1) / (NIR + SWIR1)",
    roleA: "NIR",
    roleB: "SWIR1",
    colormap: "brbg",
  },
  {
    id: "nbr",
    label: "NBR",
    name: "Normalized Burn Ratio — (NIR - SWIR2) / (NIR + SWIR2)",
    roleA: "NIR",
    roleB: "SWIR2",
    colormap: "rdylgn",
  },
  {
    id: "ndbi",
    label: "NDBI",
    name: "Normalized Difference Built-up Index — (SWIR1 - NIR) / (SWIR1 + NIR)",
    roleA: "SWIR1",
    roleB: "NIR",
    colormap: "inferno",
  },
  {
    id: "ndsi",
    label: "NDSI",
    name: "Normalized Difference Snow Index — (Green - SWIR1) / (Green + SWIR1)",
    roleA: "Green",
    roleB: "SWIR1",
    colormap: "blues",
  },
];

/** The generic two-band preset, listed after the named ones. */
export const CUSTOM_NORMALIZED_DIFFERENCE: NormalizedDifferenceIndex = {
  id: "custom",
  label: "Custom",
  name: "Custom normalized difference — (Band A - Band B) / (Band A + Band B)",
  roleA: "Band A",
  roleB: "Band B",
  colormap: "rdylgn",
};

/**
 * Looks up a preset by id, including the custom preset.
 *
 * @param id - The preset id stored on the raster layer.
 * @returns The preset, or null when the id is empty or unknown.
 */
export function indexById(id: string | undefined): NormalizedDifferenceIndex | null {
  if (!id) return null;
  if (id === CUSTOM_NORMALIZED_DIFFERENCE.id) return CUSTOM_NORMALIZED_DIFFERENCE;
  return NORMALIZED_DIFFERENCE_INDICES.find((index) => index.id === id) ?? null;
}

/** Substrings that identify a spectral role inside a GDAL band name. */
const ROLE_ALIASES: Record<string, readonly string[]> = {
  red: ["red", "b04", "b4"],
  green: ["green", "b03", "b3"],
  blue: ["blue", "b02", "b2"],
  nir: ["nir", "near infrared", "b08", "b8", "b8a"],
  swir1: ["swir1", "swir 1", "swir_1", "b11"],
  swir2: ["swir2", "swir 2", "swir_2", "b12"],
};

/**
 * Guesses the 1-based band that plays a spectral role (e.g. "NIR"), matching
 * the role's common Sentinel-2 / Landsat aliases against GDAL band names.
 *
 * @param role - The role label from a preset (e.g. "Red", "NIR", "SWIR1").
 * @param bandNames - 1-indexed band number to name map, when the COG has one.
 * @returns The band number, or null when no band name matches.
 */
export function guessBandForRole(
  role: string,
  bandNames: Map<number, string> | null,
): number | null {
  if (!bandNames || bandNames.size === 0) return null;
  const aliases = ROLE_ALIASES[role.toLowerCase()] ?? [role.toLowerCase()];
  for (const [band, rawName] of bandNames) {
    const name = rawName.toLowerCase();
    if (aliases.some((alias) => name.includes(alias))) return band;
  }
  return null;
}
