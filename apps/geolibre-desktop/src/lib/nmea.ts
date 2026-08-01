/**
 * NMEA 0183 parsing for the GPS Tracking tool's external-receiver source
 * (issue #1617): turn the sentence stream coming off a serial port or a
 * Bluetooth receiver into the same {@link GpsFix} records the browser
 * Geolocation API produces, so the map marker, heading arrow, track log, and
 * GPX export all work unchanged.
 *
 * Everything here is side-effect free and transport agnostic so it can be unit
 * tested without a device: {@link NmeaAssembler} is fed whole sentences and
 * hands back fixes. The I/O half (Web Serial / Web Bluetooth) lives in
 * `nmea-source.ts`.
 *
 * Supported sentences: GGA (position, satellites, altitude, HDOP), RMC
 * (position, ground speed, track angle, date), VTG (track and speed), GSA (fix
 * mode and DOP), GST (position error statistics). GSV and everything else is
 * parsed only far enough to be recognized and ignored.
 */
import type { GpsFix } from "./gps-tracking";

/** One knot in meters per second. */
const KNOTS_TO_MPS = 0.514444;

/**
 * Default User Equivalent Range Error in meters, used to turn HDOP into the
 * horizontal accuracy radius {@link GpsFix} requires (`accuracy ≈ HDOP × UERE`).
 * NMEA has no accuracy field, so this is the standard stand-in; a receiver that
 * emits GST gives real error statistics and those are preferred over it.
 * 4 m is a mid-range value for consumer single-frequency GNSS.
 */
export const DEFAULT_UERE_M = 4;

/** GGA field 6 / quality indicator: how (and whether) the position was fixed. */
export type NmeaFixQuality =
  | "invalid"
  | "gps"
  | "dgps"
  | "pps"
  | "rtk-fixed"
  | "rtk-float"
  | "estimated"
  | "manual"
  | "simulation";

const FIX_QUALITY_BY_CODE: Record<number, NmeaFixQuality> = {
  0: "invalid",
  1: "gps",
  2: "dgps",
  3: "pps",
  4: "rtk-fixed",
  5: "rtk-float",
  6: "estimated",
  7: "manual",
  8: "simulation",
};

/** The sentence types {@link NmeaAssembler} actually reads. */
export type NmeaSentenceType = "GGA" | "RMC" | "VTG" | "GSA" | "GST";

/** A parsed sentence, normalized to SI units and decimal degrees. */
export interface NmeaSentence {
  /** Sentence type without the talker prefix, e.g. `GGA` for `$GNGGA`. */
  type: NmeaSentenceType;
  /** The two-character talker ID, e.g. `GN`, `GP`, `GL`. */
  talker: string;
  /** UTC seconds since midnight, when the sentence carries a time field. */
  timeOfDayS?: number;
  /** UTC calendar date as `[year, month, day]` (RMC only), month 1-based. */
  date?: [number, number, number];
  lng?: number;
  lat?: number;
  /** Meters above mean sea level (GGA). */
  altitudeMslM?: number;
  /** Geoid height: MSL minus WGS84 ellipsoid, in meters (GGA). */
  geoidSeparationM?: number;
  satellitesUsed?: number;
  hdop?: number;
  /** Ground speed in meters per second. */
  speedMps?: number;
  /** Course over ground in degrees clockwise from true north. */
  headingDeg?: number;
  fixQuality?: NmeaFixQuality;
  /** GSA fix mode: 1 = no fix, 2 = 2D, 3 = 3D. */
  fixMode?: number;
  /** Horizontal position error radius in meters, derived from GST. */
  accuracyM?: number;
}

/**
 * XOR checksum of the payload between `$` and `*`, as two uppercase hex digits.
 * Exported for the tests and for building sentences in fixtures.
 */
export function nmeaChecksum(payload: string): string {
  let sum = 0;
  for (let i = 0; i < payload.length; i += 1) sum ^= payload.charCodeAt(i);
  return sum.toString(16).toUpperCase().padStart(2, "0");
}

/**
 * Validate a raw sentence's trailing `*XX` checksum.
 *
 * A missing checksum passes: it is optional in NMEA 0183 and several Bluetooth
 * receivers omit it. A *present but wrong* checksum fails, which is what
 * actually matters — that is the corruption case.
 */
export function nmeaChecksumValid(raw: string): boolean {
  const body = raw.trim().replace(/^[$!]/, "");
  const star = body.lastIndexOf("*");
  if (star === -1) return true;
  const given = body.slice(star + 1).trim();
  if (!/^[0-9a-fA-F]{2}$/.test(given)) return false;
  return given.toUpperCase() === nmeaChecksum(body.slice(0, star));
}

/** Parse a numeric field, returning undefined for empty or malformed values. */
function num(field: string | undefined): number | undefined {
  if (!field) return undefined;
  const n = Number(field);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Convert an NMEA `ddmm.mmmm` / `dddmm.mmmm` magnitude plus its hemisphere
 * letter into signed decimal degrees. The degrees field is whatever precedes
 * the last two integer digits, so this handles both latitude and longitude
 * without being told which it is.
 */
export function parseNmeaCoordinate(
  value: string | undefined,
  hemisphere: string | undefined,
): number | undefined {
  if (!value || !hemisphere) return undefined;
  const dot = value.indexOf(".");
  // Degrees occupy everything except the two minutes digits before the point.
  const split = (dot === -1 ? value.length : dot) - 2;
  if (split < 1) return undefined;
  const degrees = Number(value.slice(0, split));
  const minutes = Number(value.slice(split));
  if (!Number.isFinite(degrees) || !Number.isFinite(minutes)) return undefined;
  const decimal = degrees + minutes / 60;
  const h = hemisphere.toUpperCase();
  if (h === "S" || h === "W") return -decimal;
  if (h === "N" || h === "E") return decimal;
  return undefined;
}

/** Parse `hhmmss.sss` into UTC seconds since midnight. */
export function parseNmeaTime(field: string | undefined): number | undefined {
  if (!field || field.length < 6) return undefined;
  const hours = Number(field.slice(0, 2));
  const minutes = Number(field.slice(2, 4));
  const seconds = Number(field.slice(4));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return undefined;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Days in a 1-based month, accounting for leap years. */
function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (month === 2 && leap) return 29;
  return DAYS_IN_MONTH[month - 1];
}

/**
 * Parse RMC's `ddmmyy` date field. The two-digit year follows the NMEA
 * convention of 1900 for 80-99 and 2000 for 00-79.
 *
 * The day is validated against the specific month rather than a flat 1-31,
 * because `Date.UTC` silently rolls an impossible date forward — a corrupt
 * `3102yy` would otherwise land the fix on 3 March instead of being rejected.
 */
export function parseNmeaDate(field: string | undefined): [number, number, number] | undefined {
  if (!field || field.length !== 6) return undefined;
  const day = Number(field.slice(0, 2));
  const month = Number(field.slice(2, 4));
  const yy = Number(field.slice(4, 6));
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(yy)) return undefined;
  if (month < 1 || month > 12) return undefined;
  const year = yy >= 80 ? 1900 + yy : 2000 + yy;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  return [year, month, day];
}

/**
 * Parse one raw NMEA sentence. Returns null for anything not understood: a bad
 * checksum, a non-NMEA line, an AIS (`!`) sentence, a proprietary (`$P…`)
 * sentence, or a supported type whose payload is unusable.
 */
export function parseNmeaSentence(raw: string): NmeaSentence | null {
  const line = raw.trim();
  if (!line.startsWith("$")) return null;
  if (!nmeaChecksumValid(line)) return null;
  const star = line.lastIndexOf("*");
  const body = line.slice(1, star === -1 ? undefined : star);
  const f = body.split(",");
  const address = f[0] ?? "";
  // Standard addresses are a 2-character talker plus a 3-character type;
  // proprietary sentences ($PUBX, $PGRMx, …) do not fit and are ignored.
  if (address.length !== 5) return null;
  const talker = address.slice(0, 2).toUpperCase();
  const type = address.slice(2).toUpperCase();

  switch (type) {
    case "GGA": {
      const quality = FIX_QUALITY_BY_CODE[num(f[6]) ?? 0] ?? "invalid";
      return {
        type: "GGA",
        talker,
        timeOfDayS: parseNmeaTime(f[1]),
        lat: parseNmeaCoordinate(f[2], f[3]),
        lng: parseNmeaCoordinate(f[4], f[5]),
        fixQuality: quality,
        satellitesUsed: num(f[7]),
        hdop: num(f[8]),
        altitudeMslM: num(f[9]),
        geoidSeparationM: num(f[11]),
      };
    }
    case "RMC": {
      // Field 2 is the status: A(ctive) or V(oid, i.e. warning/no fix).
      const active = (f[2] ?? "").toUpperCase() === "A";
      const knots = num(f[7]);
      return {
        type: "RMC",
        talker,
        timeOfDayS: parseNmeaTime(f[1]),
        date: parseNmeaDate(f[9]),
        lat: parseNmeaCoordinate(f[3], f[4]),
        lng: parseNmeaCoordinate(f[5], f[6]),
        speedMps: knots != null ? knots * KNOTS_TO_MPS : undefined,
        headingDeg: num(f[8]),
        fixQuality: active ? undefined : "invalid",
      };
    }
    case "VTG": {
      // Prefer the km/h field (7) when present, else convert the knots field (5).
      const kmh = num(f[7]);
      const knots = num(f[5]);
      const speedMps = kmh != null ? kmh / 3.6 : knots != null ? knots * KNOTS_TO_MPS : undefined;
      return {
        type: "VTG",
        talker,
        // Field 1 is course over ground relative to true north; field 3 is
        // magnetic and is deliberately not used.
        headingDeg: num(f[1]),
        speedMps,
      };
    }
    case "GSA":
      return {
        type: "GSA",
        talker,
        fixMode: num(f[2]),
        hdop: num(f[16]),
      };
    case "GST": {
      // Fields 6 and 7 are the 1-sigma latitude and longitude error in meters.
      const latErr = num(f[6]);
      const lngErr = num(f[7]);
      if (latErr == null || lngErr == null) return { type: "GST", talker };
      return {
        type: "GST",
        talker,
        timeOfDayS: parseNmeaTime(f[1]),
        // Combine the two axes into one radius and scale 1-sigma to the 95%
        // confidence the Geolocation API's `accuracy` is defined at (~2 sigma),
        // so an NMEA fix's accuracy means the same thing as a browser fix's.
        accuracyM: Math.hypot(latErr, lngErr) * 2,
      };
    }
    default:
      return null;
  }
}

/**
 * Split a growing byte-stream buffer into complete sentences, returning the
 * unterminated remainder to be prepended to the next chunk. Handles CRLF, bare
 * LF, and bare CR line endings.
 */
export function splitNmeaLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\r\n|\r|\n/);
  // The final part has no terminator yet, so it is carried into the next read.
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.trim().length > 0), rest };
}

/** Accumulated state for the epoch currently being assembled. */
interface Epoch {
  timeOfDayS?: number;
  date?: [number, number, number];
  lng?: number;
  lat?: number;
  altitudeMslM?: number;
  geoidSeparationM?: number;
  satellitesUsed?: number;
  hdop?: number;
  speedMps?: number;
  headingDeg?: number;
  fixQuality?: NmeaFixQuality;
  fixMode?: number;
  accuracyM?: number;
  seen: Set<NmeaSentenceType>;
  /** True once any sentence in this epoch reported an unusable fix. */
  invalid: boolean;
}

function emptyEpoch(): Epoch {
  return { seen: new Set(), invalid: false };
}

/** A quality summary of the live NMEA stream, for the dialog's readout. */
export interface NmeaStreamStats {
  /** Sentences parsed into something usable. */
  parsed: number;
  /** Lines rejected: bad checksum, unknown type, or unparseable. */
  ignored: number;
  /** Fixes emitted. */
  fixes: number;
  /** Quality of the most recent position-bearing sentence. */
  fixQuality: NmeaFixQuality | null;
  /** GSA fix mode of the last epoch: 1 = none, 2 = 2D, 3 = 3D. */
  fixMode: number | null;
  /** Talker IDs seen in the stream, e.g. `GN`, `GP`. */
  talkers: string[];
}

/**
 * Assemble a stream of NMEA sentences into {@link GpsFix} records.
 *
 * A receiver reports one position "epoch" as a burst of related sentences
 * (typically GGA, GSA, GSV…, RMC, VTG), so the fields for a single fix are
 * spread across several lines and must be merged before a fix can be emitted.
 * The assembler closes an epoch when either the UTC time field changes or a
 * sentence type repeats — the second rule matters because VTG and GSA carry no
 * time of their own, so time alone cannot group them.
 *
 * A fix is therefore emitted when the *next* epoch begins, which at a typical
 * 1 Hz output rate means a fix is handed over about a second after it was
 * measured. {@link flush} force-closes the pending epoch for callers reading a
 * finite stream.
 */
export class NmeaAssembler {
  private epoch: Epoch = emptyEpoch();

  private readonly talkers = new Set<string>();

  private stats: NmeaStreamStats = {
    parsed: 0,
    ignored: 0,
    fixes: 0,
    fixQuality: null,
    fixMode: null,
    talkers: [],
  };

  /**
   * Feed one raw sentence. Returns a completed {@link GpsFix} when this
   * sentence started a new epoch and the epoch it closed held a usable
   * position, otherwise null.
   */
  push(raw: string): GpsFix | null {
    const sentence = parseNmeaSentence(raw);
    if (!sentence) {
      this.stats.ignored += 1;
      return null;
    }
    this.stats.parsed += 1;
    this.talkers.add(sentence.talker);

    // Close the current epoch when the clock moves on, or when a sentence type
    // repeats (the only boundary signal for the sentences that carry no time).
    let fix: GpsFix | null = null;
    const timeMoved =
      sentence.timeOfDayS != null &&
      this.epoch.timeOfDayS != null &&
      sentence.timeOfDayS !== this.epoch.timeOfDayS;
    if (timeMoved || this.epoch.seen.has(sentence.type)) {
      fix = this.flush();
    }
    this.merge(sentence);
    return fix;
  }

  /** Fold a parsed sentence's populated fields into the pending epoch. */
  private merge(s: NmeaSentence): void {
    const e = this.epoch;
    e.seen.add(s.type);
    if (s.timeOfDayS != null) e.timeOfDayS = s.timeOfDayS;
    if (s.date != null) e.date = s.date;
    if (s.lat != null) e.lat = s.lat;
    if (s.lng != null) e.lng = s.lng;
    if (s.altitudeMslM != null) e.altitudeMslM = s.altitudeMslM;
    if (s.geoidSeparationM != null) e.geoidSeparationM = s.geoidSeparationM;
    if (s.satellitesUsed != null) e.satellitesUsed = s.satellitesUsed;
    if (s.hdop != null) e.hdop = s.hdop;
    if (s.speedMps != null) e.speedMps = s.speedMps;
    if (s.headingDeg != null) e.headingDeg = s.headingDeg;
    if (s.fixMode != null) e.fixMode = s.fixMode;
    if (s.accuracyM != null) e.accuracyM = s.accuracyM;
    if (s.fixQuality != null) {
      if (s.fixQuality === "invalid") e.invalid = true;
      else e.fixQuality = s.fixQuality;
    }
  }

  /**
   * Close the pending epoch and start a new one, returning its fix if it held a
   * usable position. The live transports deliberately do not call this on
   * disconnect — a fix emitted during teardown races the caller's own cleanup —
   * so it exists for callers that drive the assembler over a finite stream.
   */
  flush(): GpsFix | null {
    const e = this.epoch;
    this.epoch = emptyEpoch();
    // Record what this epoch reported about fix quality before deciding whether
    // it yields a position. A receiver that loses lock produces epochs that are
    // dropped, so updating quality only on success would leave the readout
    // showing the last good "GPS fix" while the device reports none. Epochs
    // carrying no quality information at all (VTG/GSA only) leave it unchanged.
    if (e.invalid) this.stats.fixQuality = "invalid";
    else if (e.fixQuality) this.stats.fixQuality = e.fixQuality;
    if (e.fixMode != null) this.stats.fixMode = e.fixMode;

    if (e.invalid || e.lat == null || e.lng == null) return null;
    // A position at exactly 0,0 with no satellites is the classic "no fix yet"
    // output of a receiver that is still acquiring, not a fix in the Gulf of
    // Guinea.
    if (e.lat === 0 && e.lng === 0 && !e.satellitesUsed) return null;

    const fix: GpsFix = {
      lng: e.lng,
      lat: e.lat,
      accuracy: this.accuracyFor(e),
      satellites: e.satellitesUsed ?? null,
      // GpsFix altitude is height above the WGS84 ellipsoid, while GGA reports
      // height above mean sea level plus the geoid separation between them.
      altitude: e.altitudeMslM != null ? e.altitudeMslM + (e.geoidSeparationM ?? 0) : null,
      heading: e.headingDeg != null && Number.isFinite(e.headingDeg) ? e.headingDeg : null,
      speed: e.speedMps != null && Number.isFinite(e.speedMps) ? e.speedMps : null,
      timestamp: epochTimestamp(e.timeOfDayS, e.date),
    };
    this.stats.fixes += 1;
    return fix;
  }

  /**
   * Horizontal accuracy in meters: the receiver's own error statistics when it
   * emits GST, otherwise HDOP scaled by {@link DEFAULT_UERE_M}. With neither,
   * fall back to a deliberately pessimistic value rather than claim precision
   * the sentence stream never reported.
   */
  private accuracyFor(e: Epoch): number {
    if (e.accuracyM != null && Number.isFinite(e.accuracyM)) return e.accuracyM;
    if (e.hdop != null && Number.isFinite(e.hdop) && e.hdop > 0) return e.hdop * DEFAULT_UERE_M;
    return 50;
  }

  /** A snapshot of stream health for the dialog's readout. */
  getStats(): NmeaStreamStats {
    return { ...this.stats, talkers: [...this.talkers].sort() };
  }
}

/**
 * Build an epoch-millisecond timestamp from NMEA's UTC time of day and, when
 * RMC supplied it, its date. Without a date the current UTC day is assumed,
 * with a one-day correction when the sentence time and the host clock sit on
 * opposite sides of midnight.
 */
export function epochTimestamp(
  timeOfDayS: number | undefined,
  date: [number, number, number] | undefined,
  now = Date.now(),
): number {
  if (timeOfDayS == null) return now;
  if (date) {
    const [year, month, day] = date;
    return Date.UTC(year, month - 1, day) + timeOfDayS * 1000;
  }
  const midnight = Math.floor(now / 86_400_000) * 86_400_000;
  let stamp = midnight + timeOfDayS * 1000;
  // Straddling midnight: a sentence stamped 23:59 read just after 00:00 UTC
  // belongs to the previous day, and vice versa.
  const halfDay = 43_200_000;
  if (stamp - now > halfDay) stamp -= 86_400_000;
  else if (now - stamp > halfDay) stamp += 86_400_000;
  return stamp;
}
