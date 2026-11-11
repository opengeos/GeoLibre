/**
 * NTRIP correction settings for the GPS Tracking tool (issue #3400). The client
 * itself runs natively in the Android plugin (`NtripClient.kt`), which writes
 * RTCM straight to the Bluetooth receiver; this module only holds the
 * configuration the dialog edits, its validation, and its persistence.
 *
 * The browser build has no NTRIP client: a page cannot open the raw TCP
 * connection a caster speaks, and casters do not send CORS headers.
 */

/** Where to get corrections from, as the user typed it. */
export interface NtripConfig {
  host: string;
  port: number;
  /** Mountpoint name, without a leading slash. */
  mountpoint: string;
  username: string;
  password: string;
  /** Connect over TLS (some casters offer it, commonly on port 2102 or 443). */
  tls: boolean;
}

/** The registered NTRIP port, and what nearly every caster listens on. */
export const DEFAULT_NTRIP_PORT = 2101;

export const DEFAULT_NTRIP_CONFIG: NtripConfig = {
  host: "",
  port: DEFAULT_NTRIP_PORT,
  mountpoint: "",
  username: "",
  password: "",
  tls: false,
};

/** Why a config cannot be started, as an i18n key under `gps.`. */
export type NtripConfigProblem = "ntripNeedsHost" | "ntripNeedsMountpoint" | "ntripBadPort";

/**
 * Trim the typed values into what the client sends: whitespace off the host
 * and mountpoint, a leading `/` off the mountpoint (casters list them both
 * ways), and a scheme or path off a pasted host (`http://caster.example:2101/`).
 * A port in the pasted host wins over the port field. Credentials are left
 * exactly as typed.
 */
export function normalizeNtripConfig(config: NtripConfig): NtripConfig {
  let host = config.host.trim().replace(/^[a-z]+:\/\//i, "");
  host = host.split("/")[0];
  let port = config.port;
  const withPort = /^([^:\s]+):(\d+)$/.exec(host);
  if (withPort) {
    host = withPort[1];
    port = Number(withPort[2]);
  }
  return {
    ...config,
    host,
    port,
    mountpoint: config.mountpoint.trim().replace(/^\/+/, ""),
  };
}

/** The first thing stopping `config` from starting, or null when it can. */
export function ntripConfigProblem(config: NtripConfig): NtripConfigProblem | null {
  const normalized = normalizeNtripConfig(config);
  if (!normalized.host) return "ntripNeedsHost";
  if (!Number.isInteger(normalized.port) || normalized.port < 1 || normalized.port > 65535)
    return "ntripBadPort";
  if (!normalized.mountpoint) return "ntripNeedsMountpoint";
  return null;
}

const NTRIP_STORAGE_KEY = "geolibre.gpsTracking.ntrip";

/**
 * What the dialog remembers between sessions: the caster settings, and
 * whether corrections were running when the receiver was last used, so they
 * restart on their own when it reconnects.
 */
export interface StoredNtripSettings {
  config: NtripConfig;
  autoStart: boolean;
}

/**
 * Load the remembered settings. Like the app's other saved credentials on
 * mobile, the password lives in this WebView's localStorage; there is no OS
 * credential store in the Android build.
 */
export function loadNtripSettings(storage: Storage | null = safeStorage()): StoredNtripSettings {
  const fallback = { config: { ...DEFAULT_NTRIP_CONFIG }, autoStart: false };
  try {
    const raw = storage?.getItem(NTRIP_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { config?: Partial<NtripConfig>; autoStart?: unknown };
    const c: Partial<NtripConfig> = parsed.config ?? {};
    return {
      config: {
        host: typeof c.host === "string" ? c.host : "",
        port: typeof c.port === "number" ? c.port : DEFAULT_NTRIP_PORT,
        mountpoint: typeof c.mountpoint === "string" ? c.mountpoint : "",
        username: typeof c.username === "string" ? c.username : "",
        password: typeof c.password === "string" ? c.password : "",
        tls: c.tls === true,
      },
      autoStart: parsed.autoStart === true,
    };
  } catch {
    return fallback;
  }
}

export function saveNtripSettings(
  settings: StoredNtripSettings,
  storage: Storage | null = safeStorage(),
): void {
  try {
    storage?.setItem(NTRIP_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Best-effort; the session keeps the in-memory settings.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** State of the correction stream, as the native client reports it. */
export type NtripState = "connecting" | "connected" | "error" | "stopped";

/**
 * `auth-failed` and `mountpoint` stop the client (retrying cannot help);
 * `failed` is retried by the client every few seconds.
 */
export type NtripErrorCode = "auth-failed" | "mountpoint" | "failed";

export interface NtripStatus {
  state: NtripState;
  /** Correction bytes written to the receiver this session. */
  bytes: number;
  message?: string;
  code?: NtripErrorCode;
}

/** Map the plugin's error code onto {@link NtripErrorCode}. */
export function ntripErrorCode(native: string | undefined): NtripErrorCode {
  if (native === "AUTH_FAILED") return "auth-failed";
  if (native === "MOUNTPOINT") return "mountpoint";
  return "failed";
}

/** "12.3 kB"-style size for the correction counter. */
export function formatNtripBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}
