/**
 * Conversions between a signed decimal degree and its degrees/minutes/seconds
 * (DMS) or degrees/decimal-minutes (DDM) parts, used by the Set View dialog's
 * DD/DMS/DDM coordinate toggle. Kept separate from the React component so the
 * math can be unit tested in isolation.
 */

/** Which coordinate axis a value belongs to — they use different hemispheres. */
export type Axis = "lat" | "lon";

/** A single axis as degrees/minutes/seconds plus a hemisphere letter. */
export interface DmsAxis {
  deg: string;
  min: string;
  sec: string;
  /** Hemisphere letter: "N"/"S" for latitude, "E"/"W" for longitude. */
  dir: string;
}

/** A single axis as degrees and decimal minutes plus a hemisphere letter. */
export interface DdmAxis {
  deg: string;
  /** Decimal minutes, e.g. "30.44". */
  min: string;
  /** Hemisphere letter: "N"/"S" for latitude, "E"/"W" for longitude. */
  dir: string;
}

/** The [positive, negative] hemisphere letters for each axis. */
const HEMISPHERES: Record<Axis, readonly [string, string]> = {
  lat: ["N", "S"],
  lon: ["E", "W"],
};

/**
 * Splits a signed decimal degree into degrees/minutes/seconds, choosing the
 * hemisphere from the sign.
 *
 * Seconds are rounded to two decimals and any carry is propagated into minutes
 * and degrees, so a value like 12.99999 never renders as 60 seconds. Returns
 * blank parts (so the inputs show empty) when the input is not finite.
 *
 * @param decimal Signed decimal degrees, e.g. -98.468972.
 * @param axis The axis the value belongs to, which picks the hemisphere pair.
 * @returns The degrees/minutes/seconds parts and hemisphere as strings.
 */
export function decimalToDmsAxis(decimal: number, axis: Axis): DmsAxis {
  const [pos, neg] = HEMISPHERES[axis];
  if (!Number.isFinite(decimal)) {
    return { deg: "", min: "", sec: "", dir: pos };
  }
  const dir = decimal < 0 ? neg : pos;
  const abs = Math.abs(decimal);
  let deg = Math.floor(abs);
  let min = Math.floor((abs - deg) * 60);
  let sec = Number(((abs - deg) * 3600 - min * 60).toFixed(2));
  if (sec >= 60) {
    sec -= 60;
    min += 1;
  }
  if (min >= 60) {
    min -= 60;
    deg += 1;
  }
  return { deg: String(deg), min: String(min), sec: String(sec), dir };
}

/**
 * Recombines degrees/minutes/seconds parts into a signed decimal degree.
 *
 * Degrees are required; minutes and seconds default to 0 when left blank.
 * Returns NaN when any part is non-numeric, degrees are negative (the sign is
 * carried by the hemisphere, not the degrees field), or minutes/seconds fall
 * outside [0, 60), so the caller's range check rejects the value rather than
 * flying somewhere unexpected.
 *
 * @param parts The degrees/minutes/seconds and hemisphere strings.
 * @param axis The axis the value belongs to, which picks the hemisphere pair.
 * @returns Signed decimal degrees, or NaN if the parts are invalid.
 */
export function dmsAxisToDecimal(parts: DmsAxis, axis: Axis): number {
  const [, neg] = HEMISPHERES[axis];
  if (parts.deg.trim() === "") return NaN;
  const deg = Number(parts.deg);
  const min = parts.min.trim() === "" ? 0 : Number(parts.min);
  const sec = parts.sec.trim() === "" ? 0 : Number(parts.sec);
  if (![deg, min, sec].every(Number.isFinite)) return NaN;
  if (deg < 0 || min < 0 || min >= 60 || sec < 0 || sec >= 60) return NaN;
  const magnitude = deg + min / 60 + sec / 3600;
  return parts.dir === neg ? -magnitude : magnitude;
}

/**
 * Splits a signed decimal degree into degrees and decimal minutes (DDM),
 * choosing the hemisphere from the sign.
 *
 * Minutes are rounded to four decimals and any carry is propagated into degrees,
 * so a value never renders as 60 minutes. Returns blank parts (so the inputs
 * show empty) when the input is not finite.
 *
 * @param decimal Signed decimal degrees, e.g. -98.468972.
 * @param axis The axis the value belongs to, which picks the hemisphere pair.
 * @returns The degrees and decimal-minutes parts and hemisphere as strings.
 */
export function decimalToDdmAxis(decimal: number, axis: Axis): DdmAxis {
  const [pos, neg] = HEMISPHERES[axis];
  if (!Number.isFinite(decimal)) {
    return { deg: "", min: "", dir: pos };
  }
  const dir = decimal < 0 ? neg : pos;
  const abs = Math.abs(decimal);
  let deg = Math.floor(abs);
  let min = Number(((abs - deg) * 60).toFixed(4));
  if (min >= 60) {
    min -= 60;
    deg += 1;
  }
  return { deg: String(deg), min: String(min), dir };
}

/**
 * Recombines degrees and decimal minutes (DDM) parts into a signed decimal
 * degree.
 *
 * Degrees are required; minutes default to 0 when left blank. Returns NaN when
 * any part is non-numeric, degrees are negative (the sign is carried by the
 * hemisphere, not the degrees field), or minutes fall outside [0, 60), so the
 * caller's range check rejects the value rather than flying somewhere
 * unexpected.
 *
 * @param parts The degrees and decimal-minutes and hemisphere strings.
 * @param axis The axis the value belongs to, which picks the hemisphere pair.
 * @returns Signed decimal degrees, or NaN if the parts are invalid.
 */
export function ddmAxisToDecimal(parts: DdmAxis, axis: Axis): number {
  const [, neg] = HEMISPHERES[axis];
  if (parts.deg.trim() === "") return NaN;
  const deg = Number(parts.deg);
  const min = parts.min.trim() === "" ? 0 : Number(parts.min);
  if (![deg, min].every(Number.isFinite)) return NaN;
  if (deg < 0 || min < 0 || min >= 60) return NaN;
  const magnitude = deg + min / 60;
  return parts.dir === neg ? -magnitude : magnitude;
}
