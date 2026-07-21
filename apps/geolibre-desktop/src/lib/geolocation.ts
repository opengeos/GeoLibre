/**
 * Cross-platform geolocation for the Field Collection and GPS Tracking tools.
 *
 * On desktop and in the browser we read position through the WebView's
 * `navigator.geolocation`. That path is broken inside the packaged Android/iOS
 * app: on Android the WebView tries to request `ACCESS_FINE/COARSE_LOCATION` at
 * runtime, but those permissions aren't declared in the (generated, gitignored)
 * AndroidManifest, so Android auto-denies the request without ever showing the
 * system dialog — the user "is never asked for GPS" and the failing request path
 * crashes the app (reported on a Galaxy S25 Ultra).
 *
 * So on Tauri **mobile** we go through the official `@tauri-apps/plugin-
 * geolocation` instead: its Android/iOS library ships the location
 * `<uses-permission>` manifest entries and drives the OS permission dialog, and
 * it reads position natively rather than via the fragile WebView bridge. The
 * plugin is loaded lazily so it never enters the web bundle.
 */
import type {
  Position as PluginPosition,
  PositionOptions as PluginPositionOptions,
} from "@tauri-apps/plugin-geolocation";
import { isMobile } from "./is-mobile";
import { isTauri } from "./is-tauri";

/**
 * True when geolocation must go through the native Tauri plugin rather than the
 * WebView. Only the packaged mobile app: a phone browser matches `isMobile()`
 * but isn't Tauri (no plugin), so it correctly stays on `navigator.geolocation`.
 */
export function useNativeGeolocation(): boolean {
  return isTauri() && isMobile();
}

/** Why a geolocation request failed, so callers can pick the right message. */
export class GeolocationError extends Error {
  constructor(
    message: string,
    /** The user (or OS) refused location access. */
    readonly permissionDenied: boolean,
    /** No geolocation source at all (no `navigator.geolocation`, unsupported). */
    readonly unavailable: boolean = false,
  ) {
    super(message);
    this.name = "GeolocationError";
  }
}

/**
 * The plugin's `Position` is structurally the subset of `GeolocationPosition`
 * that both tools read (`coords.{longitude,latitude,accuracy,heading,speed}` and
 * `timestamp`), so callers keep using the browser type. The prototype (`toJSON`,
 * `GeolocationCoordinates`) is absent, but nothing reads it — hence the cast.
 */
function fromPlugin(p: PluginPosition): GeolocationPosition {
  return p as unknown as GeolocationPosition;
}

/**
 * The browser's `PositionOptions` are all optional; the plugin's require every
 * field. Fill in browser-equivalent defaults (accuracy off, no cached fix). The
 * `timeout` default is finite because the plugin can't take the browser's
 * `Infinity`; it's ignored on Android for a one-shot read and only bounds the
 * per-update wait for a watch.
 */
function toPluginOptions(o?: PositionOptions): PluginPositionOptions {
  return {
    enableHighAccuracy: o?.enableHighAccuracy ?? false,
    timeout: o?.timeout ?? 30000,
    maximumAge: o?.maximumAge ?? 0,
  };
}

/**
 * Ensure native location permission, prompting once if it hasn't been decided.
 * Throws {@link GeolocationError} (permissionDenied) if the user refuses.
 */
async function ensureNativePermission(): Promise<void> {
  const { checkPermissions, requestPermissions } = await import(
    "@tauri-apps/plugin-geolocation"
  );
  let status = await checkPermissions();
  const undecided = (s: string) => s === "prompt" || s === "prompt-with-rationale";
  if (undecided(status.location) || undecided(status.coarseLocation)) {
    status = await requestPermissions(["location", "coarseLocation"]);
  }
  if (status.location !== "granted" && status.coarseLocation !== "granted") {
    throw new GeolocationError("Location permission denied", true);
  }
}

/**
 * A single position fix. Rejects with {@link GeolocationError} on failure.
 * Native mobile requests OS permission first; elsewhere this wraps
 * `navigator.geolocation.getCurrentPosition`.
 */
export async function getCurrentPosition(
  options?: PositionOptions,
): Promise<GeolocationPosition> {
  if (useNativeGeolocation()) {
    await ensureNativePermission();
    const { getCurrentPosition: nativeGet } = await import(
      "@tauri-apps/plugin-geolocation"
    );
    return fromPlugin(await nativeGet(toPluginOptions(options)));
  }
  if (!("geolocation" in navigator)) {
    throw new GeolocationError("Geolocation unavailable", false, true);
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      resolve,
      (err) =>
        reject(
          new GeolocationError(err.message, err.code === err.PERMISSION_DENIED),
        ),
      options,
    );
  });
}

/**
 * Continuously watch position. Fixes go to `onFix`; recoverable problems (denied
 * permission, transient signal loss) go to `onError`. Resolves to an unsubscribe
 * function; rejects with {@link GeolocationError} only when a watch can't start
 * at all (no geolocation source, native permission refused up front).
 */
export async function watchPosition(
  onFix: (pos: GeolocationPosition) => void,
  onError: (err: GeolocationError) => void,
  options?: PositionOptions,
): Promise<() => void> {
  if (useNativeGeolocation()) {
    await ensureNativePermission();
    const { watchPosition: nativeWatch, clearWatch } = await import(
      "@tauri-apps/plugin-geolocation"
    );
    const id = await nativeWatch(toPluginOptions(options), (pos, err) => {
      if (pos) onFix(fromPlugin(pos));
      // A watch error after start is treated as transient (signal loss): keep
      // watching. Up-front permission refusal already rejected above.
      else if (err) onError(new GeolocationError(err, false));
    });
    return () => {
      void clearWatch(id);
    };
  }
  if (!("geolocation" in navigator)) {
    throw new GeolocationError("Geolocation unavailable", false, true);
  }
  const id = navigator.geolocation.watchPosition(
    onFix,
    (err) =>
      onError(new GeolocationError(err.message, err.code === err.PERMISSION_DENIED)),
    options,
  );
  return () => navigator.geolocation.clearWatch(id);
}
