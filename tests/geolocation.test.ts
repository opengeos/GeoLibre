import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  GeolocationError,
  getCurrentPosition,
  nativeGeolocationAvailable,
  watchPosition,
} from "../apps/geolibre-desktop/src/lib/geolocation";

// These cover the browser/desktop path (navigator.geolocation). The native Tauri
// mobile path is gated behind nativeGeolocationAvailable() (isTauri && isMobile) and
// dynamically imports @tauri-apps/plugin-geolocation, which can't run under
// node --test — it's exercised on-device instead.

type GeolocationLike = {
  getCurrentPosition: Geolocation["getCurrentPosition"];
  watchPosition: Geolocation["watchPosition"];
  clearWatch: Geolocation["clearWatch"];
};

function setNavigator(geolocation?: GeolocationLike, userAgent = "node-test") {
  const nav = geolocation
    ? { userAgent, maxTouchPoints: 0, geolocation }
    : { userAgent, maxTouchPoints: 0 };
  Object.defineProperty(globalThis, "navigator", {
    value: nav,
    configurable: true,
    writable: true,
  });
}

function setWindow(tauri: boolean) {
  Object.defineProperty(globalThis, "window", {
    value: tauri ? { __TAURI_INTERNALS__: {} } : {},
    configurable: true,
    writable: true,
  });
}

const okPosition = {
  coords: { longitude: -122.4, latitude: 37.8, accuracy: 5 },
  timestamp: 1000,
} as unknown as GeolocationPosition;

// A GeolocationPositionError with the PERMISSION_DENIED discriminant the wrapper reads.
function positionError(code: number): GeolocationPositionError {
  return {
    code,
    message: "err",
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as GeolocationPositionError;
}

afterEach(() => {
  setWindow(false);
  setNavigator();
});

describe("nativeGeolocationAvailable", () => {
  it("is false outside Tauri even on a mobile user agent", () => {
    setWindow(false);
    setNavigator(undefined, "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile");
    assert.equal(nativeGeolocationAvailable(), false);
  });

  it("is false in Tauri on a desktop user agent", () => {
    setWindow(true);
    setNavigator(undefined, "Mozilla/5.0 (X11; Linux x86_64)");
    assert.equal(nativeGeolocationAvailable(), false);
  });
});

describe("getCurrentPosition (browser path)", () => {
  it("resolves with the fix from navigator.geolocation", async () => {
    setWindow(false);
    setNavigator({
      getCurrentPosition: (ok) => ok(okPosition),
      watchPosition: () => 0,
      clearWatch: () => {},
    });
    const pos = await getCurrentPosition({ enableHighAccuracy: true });
    assert.equal(pos.coords.longitude, -122.4);
  });

  it("rejects with permissionDenied when the user refuses", async () => {
    setWindow(false);
    setNavigator({
      getCurrentPosition: (_ok, err) => err?.(positionError(1)),
      watchPosition: () => 0,
      clearWatch: () => {},
    });
    await assert.rejects(getCurrentPosition(), (e: GeolocationError) => {
      assert.equal(e instanceof GeolocationError, true);
      assert.equal(e.permissionDenied, true);
      return true;
    });
  });

  it("rejects as unavailable when the device has no geolocation", async () => {
    setWindow(false);
    setNavigator(); // no geolocation
    await assert.rejects(getCurrentPosition(), (e: GeolocationError) => {
      assert.equal(e.unavailable, true);
      assert.equal(e.permissionDenied, false);
      return true;
    });
  });
});

describe("watchPosition (browser path)", () => {
  it("delivers fixes and unsubscribes via clearWatch", async () => {
    setWindow(false);
    const fixes: GeolocationPosition[] = [];
    let cleared: number | undefined;
    setNavigator({
      getCurrentPosition: () => {},
      watchPosition: (ok) => {
        ok(okPosition);
        return 42;
      },
      clearWatch: (id) => {
        cleared = id;
      },
    });
    const unsubscribe = await watchPosition(
      (p) => fixes.push(p),
      () => {},
    );
    assert.equal(fixes.length, 1);
    unsubscribe();
    assert.equal(cleared, 42);
  });

  it("reports a denied permission through onError as transient/denied", async () => {
    setWindow(false);
    let denied = false;
    setNavigator({
      getCurrentPosition: () => {},
      watchPosition: (_ok, err) => {
        err?.(positionError(1));
        return 1;
      },
      clearWatch: () => {},
    });
    await watchPosition(
      () => {},
      (e) => {
        denied = e.permissionDenied;
      },
    );
    assert.equal(denied, true);
  });

  it("rejects when starting a watch with no geolocation source", async () => {
    setWindow(false);
    setNavigator();
    await assert.rejects(
      watchPosition(
        () => {},
        () => {},
      ),
      (e: GeolocationError) => {
        assert.equal(e.unavailable, true);
        return true;
      },
    );
  });
});
