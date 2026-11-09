/**
 * Which bands a STAC item offers, and the band combinations and spectral indices that can be made
 * from them. Ported from the Kentucky STAC QGIS plugin (`bands.py`), so the same item offers the
 * same renderings in both.
 *
 * A *band* is one raster band of one asset, found by its common name (`red`, `green`, `nir`,
 * `swir16`, ...), which catalogs give in `eo:bands` / `bands`, or failing that by the asset's key.
 * A formula such as `(nir - red) / (nir + red)` names bands this way and is checked here before
 * anything is opened. Pure: no DOM, no network.
 */
import { assetFormat, type StacItem } from "./stac-api";

export interface StacBand {
  /** The asset's key. */
  asset: string;
  /** 1-based band number inside that asset's file. */
  index: number;
  /** For menus: the band's name, else the asset's title or key. */
  label: string;
  /** Normalised common name (`red`, `nir`, `swir16`, ...) or "". */
  common: string;
  href: string;
  /** `raster:bands` scale and offset: value = DN * scale + offset. */
  scale: number;
  offset: number;
}

/** A wanted name, and the common names (or asset keys) that can stand in for it, best first. */
const ALIASES: Record<string, readonly string[]> = {
  nir: ["nir", "nir08", "nir09"],
  swir16: ["swir16", "swir1"],
  swir22: ["swir22", "swir2"],
  rededge: ["rededge", "rededge1", "rededge2", "rededge3"],
  coastal: ["coastal", "aerosol"],
  lwir: ["lwir", "lwir11", "lwir12"],
};

/** Red, green, blue channels of each band combination. */
export const COMBINATIONS: Record<string, readonly [string, string, string]> = {
  "True color": ["red", "green", "blue"],
  "Color infrared (vegetation)": ["nir", "red", "green"],
  "Shortwave infrared": ["swir22", "nir", "red"],
  "False color (urban)": ["swir22", "swir16", "red"],
  Agriculture: ["swir16", "nir", "blue"],
  Geology: ["swir22", "swir16", "blue"],
  Bathymetric: ["red", "green", "coastal"],
};

export const INDICES: Record<string, string> = {
  "NDVI (vegetation)": "(nir - red) / (nir + red)",
  "NDWI (water, green/NIR)": "(green - nir) / (green + nir)",
  "MNDWI (water, green/SWIR)": "(green - swir16) / (green + swir16)",
  "NDMI (moisture)": "(nir - swir16) / (nir + swir16)",
  "NBR (burn ratio)": "(nir - swir22) / (nir + swir22)",
  "NDBI (built-up)": "(swir16 - nir) / (swir16 + nir)",
  "SAVI (soil-adjusted vegetation)": "1.5 * (nir - red) / (nir + red + 0.5)",
  "EVI (enhanced vegetation)": "2.5 * (nir - red) / (nir + 6 * red - 7.5 * blue + 1)",
};

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  ln: Math.log,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  min: Math.min,
  max: Math.max,
};

const norm = (name: unknown): string =>
  typeof name === "string" ? name.trim().toLowerCase().replace(/-/g, "").replace(/ /g, "") : "";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scaleOffset(entry: Record<string, unknown>): [number, number] {
  const scale = Number(entry.scale ?? 1);
  const offset = Number(entry.offset ?? 0);
  return [Number.isFinite(scale) && scale !== 0 ? scale : 1, Number.isFinite(offset) ? offset : 0];
}

/**
 * Every raster band the item offers: one per band of each asset that can be drawn as a COG (a
 * single-band asset gives one).
 */
export function itemBands(item: StacItem): StacBand[] {
  const bands: StacBand[] = [];
  for (const [key, asset] of Object.entries(item.assets ?? {})) {
    if (!asset?.href || assetFormat(asset) !== "cog") continue;
    const raw = record(asset);
    const declared = raw["eo:bands"] ?? raw.bands;
    const entries = Array.isArray(declared) ? declared.map(record) : [];
    const rasters = Array.isArray(raw["raster:bands"]) ? (raw["raster:bands"] as unknown[]) : [];
    const title = asset.title || key;
    if (!entries.length) {
      const common = norm(raw["eo:common_name"] ?? raw.common_name) || norm(key);
      const [scale, offset] = scaleOffset(rasters.length ? record(rasters[0]) : raw);
      bands.push({ asset: key, index: 1, label: title, common, href: asset.href, scale, offset });
      continue;
    }
    entries.forEach((entry, i) => {
      const common =
        norm(entry.common_name ?? entry["eo:common_name"]) ||
        (entries.length === 1 ? norm(key) : "");
      const name = String(entry.description ?? entry.name ?? `band ${i + 1}`);
      const [scale, offset] = scaleOffset(i < rasters.length ? record(rasters[i]) : entry);
      bands.push({
        asset: key,
        index: i + 1,
        label: entries.length > 1 ? `${title}: ${name}` : title,
        common,
        href: asset.href,
        scale,
        offset,
      });
    });
  }
  return bands;
}

/** The band called `wanted`: a common name or an asset key, trying the usual stand-ins. */
export function findBand(bands: readonly StacBand[], wanted: string): StacBand | undefined {
  const names = ALIASES[norm(wanted)] ?? [norm(wanted)];
  for (const name of names) {
    const byCommon = bands.find((band) => band.common === name);
    if (byCommon) return byCommon;
    const byKey = bands.find((band) => norm(band.asset) === name && band.index === 1);
    if (byKey) return byKey;
  }
  return undefined;
}

/** The combinations whose three channels the item can all supply. */
export function availableCombinations(bands: readonly StacBand[]): string[] {
  return Object.entries(COMBINATIONS)
    .filter(([, channels]) => channels.every((channel) => findBand(bands, channel)))
    .map(([name]) => name);
}

/** The band names a formula uses (not its function names), in order of first use. */
export function formulaNames(formula: string): string[] {
  const names: string[] = [];
  for (const match of formula.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const rest = formula.slice((match.index ?? 0) + match[0].length).trimStart();
    if (match[0].toLowerCase() in FUNCTIONS && rest.startsWith("(")) continue;
    if (!names.includes(match[0])) names.push(match[0]);
  }
  return names;
}

type Evaluator = (values: readonly number[]) => number;

/**
 * Compiles an arithmetic formula to a function of its band values (given in the order
 * {@link formulaNames} lists them). Only numbers, band names, `+ - * / ^`, brackets and a few
 * functions are allowed; nothing is evaluated as code.
 *
 * @throws When the formula is empty, malformed, or names no band.
 */
export function compileFormula(formula: string): Evaluator {
  const text = formula.trim();
  if (!text) throw new Error("Enter a formula.");
  const tokens =
    text.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-z_][A-Za-z0-9_]*|[-+*/^(),]|\S/gi) ?? [];
  const names = formulaNames(text).map((name) => name.toLowerCase());
  if (!names.length) throw new Error("The formula names no band.");
  let at = 0;
  const peek = (): string | undefined => tokens[at];
  const take = (): string => {
    const token = tokens[at++];
    if (token === undefined) throw new Error("The formula ends too soon.");
    return token;
  };
  const expect = (token: string): void => {
    if (take() !== token) throw new Error(`Expected "${token}" in the formula.`);
  };

  const expression = (): Evaluator => {
    let left = term();
    while (peek() === "+" || peek() === "-") {
      const plus = take() === "+";
      const a = left;
      const b = term();
      left = plus ? (v) => a(v) + b(v) : (v) => a(v) - b(v);
    }
    return left;
  };
  const term = (): Evaluator => {
    let left = unary();
    while (peek() === "*" || peek() === "/") {
      const times = take() === "*";
      const a = left;
      const b = unary();
      left = times ? (v) => a(v) * b(v) : (v) => a(v) / b(v);
    }
    return left;
  };
  const unary = (): Evaluator => {
    if (peek() === "-") {
      take();
      const inner = unary();
      return (v) => -inner(v);
    }
    if (peek() === "+") {
      take();
      return unary();
    }
    return power();
  };
  const power = (): Evaluator => {
    const base = atom();
    if (peek() !== "^") return base;
    take();
    const exponent = unary();
    return (v) => base(v) ** exponent(v);
  };
  const atom = (): Evaluator => {
    const token = take();
    if (token === "(") {
      const inner = expression();
      expect(")");
      return inner;
    }
    if (/^[\d.]/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error(`"${token}" is not a number.`);
      return () => value;
    }
    if (/^[A-Za-z_]/.test(token)) {
      const lower = token.toLowerCase();
      if (peek() === "(" && lower in FUNCTIONS) {
        take();
        const args: Evaluator[] = [expression()];
        while (peek() === ",") {
          take();
          args.push(expression());
        }
        expect(")");
        const fn = FUNCTIONS[lower];
        return (v) => fn(...args.map((arg) => arg(v)));
      }
      const index = names.indexOf(lower);
      if (index < 0) throw new Error(`Unknown name "${token}".`);
      return (v) => v[index];
    }
    throw new Error(`Unexpected "${token}" in the formula.`);
  };

  const result = expression();
  if (at < tokens.length) throw new Error(`Unexpected "${tokens[at]}" in the formula.`);
  return result;
}

/** Whether a formula compiles. */
export function isValidFormula(formula: string): boolean {
  try {
    compileFormula(formula);
    return true;
  } catch {
    return false;
  }
}

/** The index names whose formulas compile and whose bands the item all has. */
export function availableIndices(bands: readonly StacBand[]): string[] {
  return Object.entries(INDICES)
    .filter(
      ([, formula]) =>
        isValidFormula(formula) && formulaNames(formula).every((name) => findBand(bands, name)),
    )
    .map(([name]) => name);
}

/** The bands a formula reads, in the order {@link formulaNames} lists them. */
export function bandsForFormula(formula: string, bands: readonly StacBand[]): StacBand[] {
  return formulaNames(formula).flatMap((name) => {
    const band = findBand(bands, name);
    return band ? [band] : [];
  });
}
