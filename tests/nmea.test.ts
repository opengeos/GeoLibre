import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_UERE_M,
  epochTimestamp,
  NmeaAssembler,
  nmeaChecksum,
  nmeaChecksumValid,
  parseNmeaCoordinate,
  parseNmeaDate,
  parseNmeaSentence,
  parseNmeaTime,
  splitNmeaLines,
} from "../apps/geolibre-desktop/src/lib/nmea";

/** Build a well-formed sentence from a payload, appending the real checksum. */
function sentence(payload: string): string {
  return `$${payload}*${nmeaChecksum(payload)}`;
}

// A real 1 Hz epoch from a consumer receiver, near Knoxville, TN.
const GGA = sentence("GNGGA,174512.00,3557.5432,N,08355.1234,W,1,09,0.92,268.4,M,-33.2,M,,");
const RMC = sentence("GNRMC,174512.00,A,3557.5432,N,08355.1234,W,4.5,187.3,010826,,,A");
const VTG = sentence("GNVTG,187.3,T,,M,4.5,N,8.334,K,A");
const GSA = sentence("GNGSA,A,3,05,13,15,20,,,,,,,,,1.81,0.92,1.56");

describe("nmeaChecksum / nmeaChecksumValid", () => {
  it("computes the XOR checksum of the sentence payload", () => {
    assert.equal(
      nmeaChecksum("GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,"),
      "47",
    );
  });

  it("accepts a correct checksum and rejects a corrupted one", () => {
    assert.equal(nmeaChecksumValid(GGA), true);
    assert.equal(nmeaChecksumValid(GGA.replace(/\*..$/, "*00")), false);
  });

  it("accepts a sentence with no checksum at all, which NMEA allows", () => {
    assert.equal(
      nmeaChecksumValid("$GNGGA,174512.00,3557.5432,N,08355.1234,W,1,09,0.92,268.4,M"),
      true,
    );
  });

  it("rejects a malformed checksum field", () => {
    assert.equal(nmeaChecksumValid("$GNGGA,174512.00*ZZ"), false);
  });
});

describe("parseNmeaCoordinate", () => {
  it("converts ddmm.mmmm latitude to signed decimal degrees", () => {
    // 35 degrees 57.5432 minutes = 35.959053...
    assert.ok(Math.abs(parseNmeaCoordinate("3557.5432", "N")! - 35.9590533) < 1e-6);
  });

  it("converts dddmm.mmmm longitude and applies the hemisphere sign", () => {
    assert.ok(Math.abs(parseNmeaCoordinate("08355.1234", "W")! - -83.91872333) < 1e-6);
  });

  it("returns undefined for empty fields or an unknown hemisphere", () => {
    assert.equal(parseNmeaCoordinate("", "N"), undefined);
    assert.equal(parseNmeaCoordinate("3557.5432", ""), undefined);
    assert.equal(parseNmeaCoordinate("3557.5432", "X"), undefined);
  });
});

describe("parseNmeaTime / parseNmeaDate", () => {
  it("parses hhmmss.sss into seconds since UTC midnight", () => {
    assert.equal(parseNmeaTime("174512.00"), 17 * 3600 + 45 * 60 + 12);
    assert.equal(parseNmeaTime("000000"), 0);
  });

  it("rejects a truncated time field", () => {
    assert.equal(parseNmeaTime("1745"), undefined);
  });

  it("parses ddmmyy with the NMEA two-digit year convention", () => {
    assert.deepEqual(parseNmeaDate("010826"), [2026, 8, 1]);
    assert.deepEqual(parseNmeaDate("311299"), [1999, 12, 31]);
  });

  it("rejects an impossible date", () => {
    assert.equal(parseNmeaDate("011326"), undefined, "month 13");
    assert.equal(parseNmeaDate("0108"), undefined, "truncated");
  });

  it("rejects a day the month cannot have, which Date.UTC would silently roll over", () => {
    // Date.UTC(1999, 1, 31) is 3 March, so accepting this would move the fix.
    assert.equal(parseNmeaDate("310299"), undefined, "31 February");
    assert.equal(parseNmeaDate("310424"), undefined, "31 April");
    assert.deepEqual(parseNmeaDate("300424"), [2024, 4, 30], "30 April is valid");
  });

  it("applies leap years to February", () => {
    assert.deepEqual(parseNmeaDate("290224"), [2024, 2, 29], "2024 is a leap year");
    assert.equal(parseNmeaDate("290223"), undefined, "2023 is not");
    assert.deepEqual(parseNmeaDate("290200"), [2000, 2, 29], "2000 is a leap year");
  });
});

describe("parseNmeaSentence", () => {
  it("parses GGA position, satellites, HDOP, and altitude", () => {
    const s = parseNmeaSentence(GGA)!;
    assert.equal(s.type, "GGA");
    assert.equal(s.talker, "GN");
    assert.equal(s.fixQuality, "gps");
    assert.equal(s.satellitesUsed, 9);
    assert.equal(s.hdop, 0.92);
    assert.equal(s.altitudeMslM, 268.4);
    assert.equal(s.geoidSeparationM, -33.2);
    assert.ok(Math.abs(s.lat! - 35.9590533) < 1e-6);
    assert.ok(Math.abs(s.lng! - -83.91872333) < 1e-6);
  });

  it("flags a GGA with quality 0 as an invalid fix", () => {
    const s = parseNmeaSentence(
      sentence("GNGGA,174512.00,3557.5432,N,08355.1234,W,0,00,,,M,,M,,"),
    )!;
    assert.equal(s.fixQuality, "invalid");
  });

  it("parses RMC speed in knots as meters per second, plus heading and date", () => {
    const s = parseNmeaSentence(RMC)!;
    assert.equal(s.type, "RMC");
    // 4.5 knots = 2.315 m/s
    assert.ok(Math.abs(s.speedMps! - 2.315) < 1e-3);
    assert.equal(s.headingDeg, 187.3);
    assert.deepEqual(s.date, [2026, 8, 1]);
  });

  it("flags a void (status V) RMC as an invalid fix", () => {
    const s = parseNmeaSentence(sentence("GNRMC,174512.00,V,,,,,,,010826,,,N"))!;
    assert.equal(s.fixQuality, "invalid");
  });

  it("prefers VTG's km/h field over its knots field", () => {
    const s = parseNmeaSentence(VTG)!;
    // 8.334 km/h = 2.315 m/s, matching the RMC knots value for the same epoch.
    assert.ok(Math.abs(s.speedMps! - 2.315) < 1e-3);
    assert.equal(s.headingDeg, 187.3);
  });

  it("parses GSA fix mode and HDOP", () => {
    const s = parseNmeaSentence(GSA)!;
    assert.equal(s.fixMode, 3);
    assert.equal(s.hdop, 0.92);
  });

  it("derives a 95% accuracy radius from GST's one-sigma errors", () => {
    const s = parseNmeaSentence(sentence("GNGST,174512.00,1.2,,,,0.9,1.2,2.1"))!;
    // hypot(0.9, 1.2) = 1.5, doubled to reach ~95% confidence.
    assert.ok(Math.abs(s.accuracyM! - 3.0) < 1e-6);
  });

  it("ignores lines that are not usable NMEA", () => {
    assert.equal(parseNmeaSentence("not a sentence"), null);
    assert.equal(parseNmeaSentence(GGA.replace(/\*..$/, "*00")), null, "bad checksum");
    assert.equal(parseNmeaSentence(sentence("GNGSV,3,1,11,05,64,132,44")), null, "unused type");
    assert.equal(parseNmeaSentence("!AIVDM,1,1,,A,15M,0*1C"), null, "AIS");
    assert.equal(parseNmeaSentence(sentence("PUBX,00,174512.00")), null, "proprietary");
  });
});

describe("splitNmeaLines", () => {
  it("returns complete lines and carries the partial remainder forward", () => {
    const { lines, rest } = splitNmeaLines("$AAA*11\r\n$BBB*22\r\n$CC");
    assert.deepEqual(lines, ["$AAA*11", "$BBB*22"]);
    assert.equal(rest, "$CC");
  });

  it("handles bare LF and bare CR terminators", () => {
    assert.deepEqual(splitNmeaLines("$A*11\n$B*22\n").lines, ["$A*11", "$B*22"]);
    assert.deepEqual(splitNmeaLines("$A*11\r$B*22\r").lines, ["$A*11", "$B*22"]);
  });
});

describe("epochTimestamp", () => {
  it("combines an RMC date with the time of day", () => {
    const t = epochTimestamp(17 * 3600 + 45 * 60 + 12, [2026, 8, 1]);
    assert.equal(new Date(t).toISOString(), "2026-08-01T17:45:12.000Z");
  });

  it("assumes the current UTC day when no date was reported", () => {
    const now = Date.UTC(2026, 7, 1, 17, 45, 30);
    const t = epochTimestamp(17 * 3600 + 45 * 60 + 12, undefined, now);
    assert.equal(new Date(t).toISOString(), "2026-08-01T17:45:12.000Z");
  });

  it("rolls back a day for a pre-midnight sentence read just after midnight", () => {
    const now = Date.UTC(2026, 7, 2, 0, 0, 30);
    const t = epochTimestamp(23 * 3600 + 59 * 60 + 50, undefined, now);
    assert.equal(new Date(t).toISOString(), "2026-08-01T23:59:50.000Z");
  });

  it("rolls forward a day for a post-midnight sentence read just before midnight", () => {
    const now = Date.UTC(2026, 7, 1, 23, 59, 50);
    const t = epochTimestamp(30, undefined, now);
    assert.equal(new Date(t).toISOString(), "2026-08-02T00:00:30.000Z");
  });
});

describe("NmeaAssembler", () => {
  /** Feed sentences in order, returning every fix emitted including the flush. */
  function run(lines: string[]): ReturnType<NmeaAssembler["flush"]>[] {
    const a = new NmeaAssembler();
    const fixes = [];
    for (const line of lines) {
      const fix = a.push(line);
      if (fix) fixes.push(fix);
    }
    const last = a.flush();
    if (last) fixes.push(last);
    return fixes;
  }

  it("merges one epoch's sentences into a single fix", () => {
    const fixes = run([GGA, GSA, RMC, VTG]);
    assert.equal(fixes.length, 1, "one epoch yields exactly one fix");
    const fix = fixes[0]!;
    assert.ok(Math.abs(fix.lat - 35.9590533) < 1e-6);
    assert.ok(Math.abs(fix.lng - -83.91872333) < 1e-6);
    assert.equal(fix.satellites, 9, "from GGA");
    assert.equal(fix.heading, 187.3, "from RMC/VTG");
    assert.ok(Math.abs(fix.speed! - 2.315) < 1e-3, "from RMC knots");
    assert.equal(new Date(fix.timestamp).toISOString(), "2026-08-01T17:45:12.000Z");
  });

  it("reports altitude above the ellipsoid, not above mean sea level", () => {
    // GGA carries 268.4 m above MSL with a geoid separation of -33.2 m.
    assert.ok(Math.abs(run([GGA, RMC])[0]!.altitude! - 235.2) < 1e-6);
  });

  it("derives accuracy from HDOP when the receiver sends no GST", () => {
    assert.ok(Math.abs(run([GGA, RMC])[0]!.accuracy - 0.92 * DEFAULT_UERE_M) < 1e-6);
  });

  it("prefers GST's measured error over the HDOP estimate", () => {
    const gst = sentence("GNGST,174512.00,1.2,,,,0.9,1.2,2.1");
    assert.ok(Math.abs(run([GGA, gst, RMC])[0]!.accuracy - 3.0) < 1e-6);
  });

  it("splits epochs when the time field advances", () => {
    const next = GGA.replace("174512.00", "174513.00");
    // Rebuild the checksum after mutating the payload.
    const nextGga = sentence(next.slice(1, next.lastIndexOf("*")));
    const fixes = run([GGA, RMC, nextGga]);
    assert.equal(fixes.length, 2);
    assert.equal(new Date(fixes[0]!.timestamp).toISOString(), "2026-08-01T17:45:12.000Z");
    assert.equal(new Date(fixes[1]!.timestamp).toISOString(), "2026-08-01T17:45:13.000Z");
  });

  it("closes an epoch when a sentence type repeats, the only boundary signal for timeless sentences", () => {
    // VTG and GSA carry no time field, so a repeat is the only way to know the
    // receiver has moved on to the next epoch.
    const a = new NmeaAssembler();
    assert.equal(a.push(GGA), null);
    assert.equal(a.push(VTG), null, "still the same epoch");
    const fix = a.push(VTG);
    assert.ok(fix, "the repeated VTG closed the pending epoch");
    assert.equal(fix!.heading, 187.3, "and the closed epoch kept the first VTG's heading");
  });

  it("drops an epoch whose fix is void", () => {
    const voidRmc = sentence("GNRMC,174512.00,V,,,,,,,010826,,,N");
    const noFixGga = sentence("GNGGA,174512.00,3557.5432,N,08355.1234,W,0,00,,,M,,M,,");
    assert.deepEqual(run([noFixGga, voidRmc]), []);
  });

  it("drops the null island position a receiver emits while acquiring", () => {
    const zero = sentence("GNGGA,174512.00,0000.0000,N,00000.0000,E,1,00,,,M,,M,,");
    assert.deepEqual(run([zero]), []);
  });

  it("emits the final in-progress epoch on flush so the last fix is not lost", () => {
    const a = new NmeaAssembler();
    assert.equal(a.push(GGA), null, "no fix until the epoch closes");
    assert.ok(a.flush(), "flush closes it");
  });

  it("reports losing the fix instead of leaving the last good quality in the readout", () => {
    const a = new NmeaAssembler();
    a.push(GGA);
    a.push(RMC);
    a.flush();
    assert.equal(a.getStats().fixQuality, "gps");
    // The receiver loses lock: these epochs yield no fix, but the readout must
    // stop claiming a GPS fix rather than showing the last good value.
    a.push(sentence("GNGGA,174513.00,3557.5432,N,08355.1234,W,0,00,,,M,,M,,"));
    a.push(sentence("GNRMC,174513.00,V,,,,,,,010826,,,N"));
    assert.equal(a.flush(), null, "no fix from a void epoch");
    assert.equal(a.getStats().fixQuality, "invalid");
  });

  it("leaves fix quality untouched for an epoch that reports none", () => {
    const a = new NmeaAssembler();
    a.push(GGA);
    a.push(RMC);
    a.flush();
    // VTG and GSA say nothing about fix quality, so they must not clear it.
    a.push(VTG);
    a.push(GSA);
    a.flush();
    assert.equal(a.getStats().fixQuality, "gps");
  });

  it("counts parsed and ignored lines and records the talkers seen", () => {
    const a = new NmeaAssembler();
    a.push(GGA);
    a.push(RMC);
    a.push("garbage");
    a.flush();
    const stats = a.getStats();
    assert.equal(stats.parsed, 2);
    assert.equal(stats.ignored, 1);
    assert.equal(stats.fixes, 1);
    assert.equal(stats.fixQuality, "gps");
    assert.deepEqual(stats.talkers, ["GN"]);
  });
});
