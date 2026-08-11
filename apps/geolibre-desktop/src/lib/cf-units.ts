/**
 * CF `units` presentation, shared by the NetCDF readout, the spectral profile
 * chart, and that chart's CSV export.
 *
 * Kept dependency-free, like `./csv`, so pure modules (and their `node --test`
 * runs) can import it without pulling in `netcdf-image-symbology` — which
 * reaches the plugin barrel and, through it, browser-only bundles.
 */

/**
 * CF `units` values that mean "this quantity has no unit". Writers spell that
 * several ways, and printing any of them next to a number is noise: EMIT
 * reflectance declares `unitless`, so a readout would say "0.0145 unitless".
 */
const EMPTY_UNITS = new Set(["", "unitless", "dimensionless", "none", "n/a", "na", "-", "1"]);

/**
 * A variable's units when they are worth showing, else undefined.
 *
 * @param units - The CF `units` attribute, if any.
 * @returns The units to render beside a value, or undefined to render none.
 */
export function displayUnits(units: string | undefined): string | undefined {
  const trimmed = units?.trim();
  if (!trimmed || EMPTY_UNITS.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}
