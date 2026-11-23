import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  nativeLocalCogProtocolUrl,
  nativeLocalPmtilesProtocolUrl,
  nativeMbtilesProtocolUrl,
  usesLocalhostCustomSchemeOrigin,
} from "../apps/geolibre-desktop/src/lib/local-media-url";
import {
  clearGpsTrackCheckpoint,
  createGpsWakeLockController,
  createThrottledCheckpointSaver,
  GPS_TRACK_CHECKPOINT_KEY,
  loadGpsTrackCheckpoint,
  saveGpsTrackCheckpoint,
  type StorageLike,
  type WakeLockDocumentLike,
  type WakeLockSentinelLike,
} from "../apps/geolibre-desktop/src/lib/gps-wake-lock";
import { shareFileWithOsSheet } from "../apps/geolibre-desktop/src/lib/file-io/file-dialogs";
import {
  checkDesktopSignedUpdate,
  installDesktopSignedUpdate,
  isDesktopSignedUpdateInstalling,
} from "../apps/geolibre-desktop/src/lib/updates";
import type { GpsFix } from "../apps/geolibre-desktop/src/lib/gps-tracking";

function makeMemoryStorage(): StorageLike {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

function makeFix(i: number): GpsFix {
  return {
    lng: -122.4 + i * 0.001,
    lat: 37.7 + i * 0.001,
    accuracy: 4.2,
    satellites: 11,
    altitude: 15,
    heading: 90,
    speed: 1.5,
    timestamp: 1_700_000_000_000 + i * 1000,
  };
}

describe("local-media-url custom URI scheme builders", () => {
  it("dispatches custom scheme origins for macOS/Linux vs Windows/Android", () => {
    const path = "/data/my maps/test #1.mbtiles";
    assert.equal(usesLocalhostCustomSchemeOrigin("windows"), true);
    assert.equal(usesLocalhostCustomSchemeOrigin("android"), true);
    assert.equal(usesLocalhostCustomSchemeOrigin("macos"), false);
    assert.equal(usesLocalhostCustomSchemeOrigin("linux"), false);

    assert.equal(
      nativeMbtilesProtocolUrl(path, "macos"),
      `mbtiles://localhost/tile/{z}/{x}/{y}?path=${encodeURIComponent(path)}`,
    );
    assert.equal(
      nativeMbtilesProtocolUrl(path, "windows"),
      `http://mbtiles.localhost/tile/{z}/{x}/{y}?path=${encodeURIComponent(path)}`,
    );
    assert.equal(
      nativeLocalPmtilesProtocolUrl("/data/basemap.pmtiles", "linux"),
      "local-pmtiles://localhost/file?path=%2Fdata%2Fbasemap.pmtiles",
    );
    assert.equal(
      nativeLocalPmtilesProtocolUrl("/data/basemap.pmtiles", "android"),
      "http://local-pmtiles.localhost/file?path=%2Fdata%2Fbasemap.pmtiles",
    );
    assert.equal(
      nativeLocalCogProtocolUrl("/data/dem 3dep.tif", "macos"),
      "local-cog://localhost/file?path=%2Fdata%2Fdem%203dep.tif",
    );
    assert.equal(
      nativeLocalCogProtocolUrl("/data/dem 3dep.tif", "windows"),
      "http://local-cog.localhost/file?path=%2Fdata%2Fdem%203dep.tif",
    );
  });
});

describe("gps-wake-lock screen wake lock & track checkpoints", () => {
  it("acquires wake lock, deduplicates concurrent requests, re-acquires on visibilitychange, and releases on stop", async () => {
    let requestCount = 0;
    let releaseCount = 0;
    let currentSentinel: WakeLockSentinelLike | null = null;
    const listeners = new Set<() => void>();
    const doc: WakeLockDocumentLike = {
      visibilityState: "visible",
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
    };
    const nav = {
      wakeLock: {
        async request(type: "screen"): Promise<WakeLockSentinelLike> {
          assert.equal(type, "screen");
          requestCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          const sentinel: WakeLockSentinelLike = {
            released: false,
            async release() {
              if (!sentinel.released) {
                sentinel.released = true;
                releaseCount += 1;
              }
            },
          };
          currentSentinel = sentinel;
          return sentinel;
        },
      },
    };

    const controller = createGpsWakeLockController({ nav, doc });
    // Two concurrent starts must share one in-flight wakeLock.request call.
    const [ok1, ok2] = await Promise.all([controller.start(), controller.start()]);
    assert.equal(ok1, true);
    assert.equal(ok2, true);
    assert.equal(requestCount, 1);
    assert.equal(controller.isHeld(), true);

    // Simulate OS dropping the wake lock while backgrounded, then returning to foreground.
    currentSentinel!.released = true;
    for (const listener of listeners) listener();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requestCount, 2);
    assert.equal(controller.isHeld(), true);

    await controller.stop();
    assert.equal(releaseCount, 1);
    assert.equal(controller.isHeld(), false);
    assert.equal(listeners.size, 0);
  });

  it("degrades gracefully when navigator.wakeLock is unavailable", async () => {
    const controller = createGpsWakeLockController({ nav: {}, doc: null });
    assert.equal(await controller.start(), false);
    assert.equal(controller.isHeld(), false);
    await controller.stop();
  });

  it("saves, restores, throttles, validates, and clears GPS track checkpoints", () => {
    const storage = makeMemoryStorage();
    const segments = [[makeFix(0), makeFix(1)], [makeFix(2)]];
    assert.equal(saveGpsTrackCheckpoint(segments, storage), true);
    const restored = loadGpsTrackCheckpoint(storage);
    assert.deepEqual(restored, segments);

    // Throttled saver avoids serializing on every fix while honoring flush().
    let nowMs = 1_000;
    const saver = createThrottledCheckpointSaver({
      intervalMs: 5_000,
      storage,
      now: () => nowMs,
    });
    assert.equal(saver.schedule([[makeFix(0)]]), true);
    nowMs = 2_000;
    assert.equal(saver.schedule([[makeFix(0), makeFix(1)]]), null);
    assert.equal(saver.flush([[makeFix(0), makeFix(1)]]), true);
    assert.equal(loadGpsTrackCheckpoint(storage)?.[0]?.length, 2);

    // Corrupt payloads fail closed and return null.
    storage.setItem(GPS_TRACK_CHECKPOINT_KEY, "{not-valid-json");
    assert.equal(loadGpsTrackCheckpoint(storage), null);

    storage.setItem(
      GPS_TRACK_CHECKPOINT_KEY,
      JSON.stringify({ version: 1, segments: [[{ lng: "bad", lat: 1 }]] }),
    );
    assert.equal(loadGpsTrackCheckpoint(storage), null);

    clearGpsTrackCheckpoint(storage);
    assert.equal(storage.getItem(GPS_TRACK_CHECKPOINT_KEY), null);
  });
});

describe("mobile OS Share Sheet export", () => {
  it("reports shared, cancelled, and unsupported outcomes accurately", async () => {
    const file = new File(["{}"], "track.geojson", { type: "application/geo+json" });
    let sharedFiles: File[] | undefined;
    const ok = await shareFileWithOsSheet(file, "Track", {
      canShare: () => true,
      share: async (data) => {
        sharedFiles = data.files;
      },
    });
    assert.equal(ok, "shared");
    assert.equal(sharedFiles?.length, 1);

    const cancelled = await shareFileWithOsSheet(file, "Track", {
      canShare: () => true,
      share: async () => {
        const err = new Error("User dismissed");
        err.name = "AbortError";
        throw err;
      },
    });
    assert.equal(cancelled, "cancelled");

    const unsupported = await shareFileWithOsSheet(file, "Track", {
      canShare: () => false,
      share: async () => undefined,
    });
    assert.equal(unsupported, "unsupported");
  });
});

describe("signed desktop auto-updater client helpers", () => {
  it("returns null / false safely outside Tauri desktop runtime", async () => {
    assert.equal(isDesktopSignedUpdateInstalling(), false);
    assert.equal(await checkDesktopSignedUpdate(), null);
    assert.equal(await installDesktopSignedUpdate(), false);
  });
});
