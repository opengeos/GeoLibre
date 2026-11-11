import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_NTRIP_CONFIG,
  formatNtripBytes,
  loadNtripSettings,
  normalizeNtripConfig,
  ntripConfigProblem,
  ntripErrorCode,
  ntripSessionRunning,
  saveNtripSettings,
} from "../apps/geolibre-desktop/src/lib/ntrip";

/** A Map-backed Storage, so persistence runs without a browser. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

const base = { ...DEFAULT_NTRIP_CONFIG, host: "caster.example.com", mountpoint: "MOUNT" };

describe("normalizeNtripConfig", () => {
  it("strips a pasted scheme, path and port out of the host", () => {
    const n = normalizeNtripConfig({ ...base, host: " http://caster.example.com:2102/ " });
    assert.equal(n.host, "caster.example.com");
    assert.equal(n.port, 2102);
  });

  it("drops a leading slash from the mountpoint and keeps credentials verbatim", () => {
    const n = normalizeNtripConfig({ ...base, mountpoint: " /RTCM3 ", password: " p w " });
    assert.equal(n.mountpoint, "RTCM3");
    assert.equal(n.password, " p w ");
  });
});

describe("ntripConfigProblem", () => {
  it("accepts a complete config", () => {
    assert.equal(ntripConfigProblem(base), null);
  });

  it("names the first missing piece", () => {
    assert.equal(ntripConfigProblem({ ...base, host: " " }), "ntripNeedsHost");
    assert.equal(ntripConfigProblem({ ...base, port: 0 }), "ntripBadPort");
    assert.equal(ntripConfigProblem({ ...base, port: 70000 }), "ntripBadPort");
    assert.equal(ntripConfigProblem({ ...base, mountpoint: "/" }), "ntripNeedsMountpoint");
    assert.equal(ntripConfigProblem({ ...base, mountpoint: "MY MOUNT" }), "ntripBadCharacters");
    assert.equal(
      ntripConfigProblem({ ...base, host: "caster.example.com\r\nX-Evil: 1" }),
      "ntripBadCharacters",
    );
  });
});

describe("NTRIP settings storage", () => {
  it("round-trips the config and auto-start flag", () => {
    const storage = memoryStorage();
    const settings = {
      config: { ...base, username: "u", password: "p", tls: true },
      autoStart: true,
    };
    saveNtripSettings(settings, storage);
    assert.deepEqual(loadNtripSettings(storage), settings);
  });

  it("falls back to defaults for missing, corrupt, or mistyped data", () => {
    const storage = memoryStorage();
    assert.deepEqual(loadNtripSettings(storage).config, DEFAULT_NTRIP_CONFIG);
    storage.setItem("geolibre.gpsTracking.ntrip", "{not json");
    assert.equal(loadNtripSettings(storage).autoStart, false);
    storage.setItem(
      "geolibre.gpsTracking.ntrip",
      JSON.stringify({ config: { port: "x", tls: 1 } }),
    );
    const loaded = loadNtripSettings(storage);
    assert.equal(loaded.config.port, 2101);
    assert.equal(loaded.config.tls, false);
  });
});

describe("NTRIP helpers", () => {
  it("maps native error codes", () => {
    assert.equal(ntripErrorCode("AUTH_FAILED"), "auth-failed");
    assert.equal(ntripErrorCode("MOUNTPOINT"), "mountpoint");
    assert.equal(ntripErrorCode("TLS_FAILED"), "tls");
    assert.equal(ntripErrorCode("FAILED"), "failed");
    assert.equal(ntripErrorCode(undefined), "failed");
  });

  it("formats byte counts", () => {
    assert.equal(formatNtripBytes(512), "512 B");
    assert.equal(formatNtripBytes(12_345), "12.3 kB");
    assert.equal(formatNtripBytes(2_500_000), "2.50 MB");
  });
});

describe("ntripSessionRunning", () => {
  it("treats only retrying errors as a live session", () => {
    assert.equal(ntripSessionRunning(null), false);
    assert.equal(ntripSessionRunning({ state: "connecting", bytes: 0 }), true);
    assert.equal(ntripSessionRunning({ state: "connected", bytes: 9 }), true);
    assert.equal(ntripSessionRunning({ state: "error", bytes: 0, code: "failed" }), true);
    for (const code of ["auth-failed", "mountpoint", "tls", "not-started"] as const)
      assert.equal(ntripSessionRunning({ state: "error", bytes: 0, code }), false, code);
    assert.equal(ntripSessionRunning({ state: "stopped", bytes: 0 }), false);
  });
});
