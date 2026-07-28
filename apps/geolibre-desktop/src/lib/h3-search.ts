/**
 * Recognizes an H3 cell index typed into the place-search box so the map can
 * jump straight to that cell. H3 (https://h3geo.org/) indexes are 64-bit
 * values that people copy around in two interchangeable spellings, and both
 * are accepted here:
 *
 * - Hexadecimal string: `8928308280fffff` (also `0x`-prefixed, any case)
 * - Unsigned 64-bit integer: `617700169958293503`
 *
 * Kept separate from the React component so the parsing can be unit tested in
 * isolation, mirroring `coordinates.ts`.
 */

import { cellToBoundary, cellToLatLng, getResolution, isValidCell } from "h3-js";

/** A resolved H3 cell: its canonical index, center, resolution, and outline. */
export interface H3CellMatch {
  /** Canonical lowercase hexadecimal H3 index. */
  cell: string;
  /** Cell center latitude in signed decimal degrees. */
  lat: number;
  /** Cell center longitude in signed decimal degrees. */
  lon: number;
  /** H3 resolution, 0 (coarsest, ~4.4M km²) to 15 (finest, ~0.9 m²). */
  resolution: number;
  /**
   * The cell outline as a closed ring of `[lon, lat]` positions. Longitudes are
   * unwrapped around the cell center, so a cell straddling the antimeridian
   * yields a contiguous ring (with values outside ±180) rather than one that
   * jumps the width of the world.
   */
  boundary: [number, number][];
}

/** An H3 cell index is 15 hex digits; 16 is allowed so `isValidCell` can judge. */
const HEX_INDEX = /^[0-9a-f]{15,16}$/;
/** Largest unsigned 64-bit value, the ceiling for the integer spelling. */
const MAX_UINT64 = 2n ** 64n - 1n;

/**
 * Convert a decimal integer spelling of an H3 index to its hexadecimal form.
 *
 * @param text A trimmed, lowercase candidate string.
 * @returns The hexadecimal index, or null when the text is not a positive
 *   integer that fits in 64 bits.
 */
function decimalToHex(text: string): string | null {
  if (!/^\d+$/.test(text)) return null;
  let value: bigint;
  try {
    value = BigInt(text);
  } catch {
    return null;
  }
  if (value <= 0n || value > MAX_UINT64) return null;
  return value.toString(16);
}

/**
 * Unwrap a boundary ring's longitudes so they stay within 180 degrees of the
 * cell center, keeping cells that cross the antimeridian contiguous.
 *
 * @param ring The raw `[lon, lat]` positions from h3-js.
 * @param centerLon The cell center longitude to unwrap around.
 * @returns The ring with adjusted longitudes.
 */
function unwrapRing(ring: number[][], centerLon: number): [number, number][] {
  return ring.map(([lon, lat]) => {
    let unwrapped = lon;
    while (unwrapped - centerLon > 180) unwrapped -= 360;
    while (unwrapped - centerLon < -180) unwrapped += 360;
    return [unwrapped, lat] as [number, number];
  });
}

/**
 * Parse free text as an H3 cell index in either the hexadecimal or the unsigned
 * 64-bit integer spelling, and resolve it to a center, resolution, and outline.
 *
 * A bare `0x`-prefixed string is read as hexadecimal only. Otherwise the text is
 * tried as hexadecimal first and then as a decimal integer, so an all-digit
 * string that happens to be a valid index in either spelling still resolves.
 * Anything that is not a valid H3 *cell* (edge and vertex indexes included)
 * returns null.
 *
 * @param input Raw text such as `8928308280fffff` or `617700169958293503`.
 * @returns The resolved cell, or null if the text is not an H3 cell index.
 */
export function parseH3Cell(input: string): H3CellMatch | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  const hexOnly = raw.startsWith("0x");
  const text = hexOnly ? raw.slice(2) : raw;

  const candidates: string[] = [];
  if (HEX_INDEX.test(text)) candidates.push(text);
  if (!hexOnly) {
    const fromDecimal = decimalToHex(text);
    if (fromDecimal && fromDecimal !== text) candidates.push(fromDecimal);
  }

  for (const cell of candidates) {
    if (!isValidCell(cell)) continue;
    const [lat, lon] = cellToLatLng(cell);
    return {
      cell,
      lat,
      lon,
      resolution: getResolution(cell),
      // `true` asks h3-js for GeoJSON order ([lon, lat]) and a closed ring.
      boundary: unwrapRing(cellToBoundary(cell, true), lon),
    };
  }
  return null;
}
