import { isTauri } from "../is-tauri";
import { OS_ENV_VAR_NAMES, type RuntimeEnv } from "./provider";

/**
 * A snapshot of the AI-provider environment variables read from the user's OS
 * environment. On the desktop app these are pulled from the real system/shell
 * environment via the `read_env_vars` Tauri command so API keys can be sourced
 * from environment variables instead of the saved project file (issue #1141).
 *
 * The webview itself cannot read `process.env`; only the Rust backend can, so
 * this is desktop-only. In the browser/Jupyter builds it resolves to `{}`. The
 * set of names read is the curated {@link OS_ENV_VAR_NAMES} allowlist (also
 * enforced Rust-side), which excludes ambient credentials like `AWS_*`.
 *
 * The result is cached on `window.__GEOLIBRE_OS_ENV__` so callers (the runtime
 * env merge, the Settings dialog badges) can read it synchronously after the
 * one-time async load without re-invoking the backend.
 */

interface OsEnvWindow {
  __GEOLIBRE_OS_ENV__?: RuntimeEnv;
}

/** Read the cached OS environment snapshot, or `{}` before it has loaded. */
export function readOsEnv(): RuntimeEnv {
  if (typeof window === "undefined") return {};
  return (window as unknown as OsEnvWindow).__GEOLIBRE_OS_ENV__ ?? {};
}

/** The OS environment is fixed for the app's lifetime, so load it at most once
 * even though several mount sites call this. The shared promise also dedupes the
 * two startup callers into a single Tauri `invoke`. */
let loadPromise: Promise<RuntimeEnv> | null = null;

/**
 * Load the allowlisted AI-provider variables from the OS environment and cache
 * them on `window.__GEOLIBRE_OS_ENV__`. Only the names in
 * {@link OS_ENV_VAR_NAMES} are requested, so unrelated environment
 * variables (PATH, HOME, …) never enter the webview. Outside Tauri this is a
 * no-op that caches an empty map.
 *
 * The result of a *successful* read is memoized: concurrent startup callers
 * share the one in-flight request, and later calls return the cached snapshot
 * without re-invoking the backend. A failed read is swallowed (a missing
 * capability must never block startup), logged for diagnosis, and — crucially —
 * does **not** poison the memo: `loadPromise` is reset so a later call retries
 * rather than the whole feature silently no-op-ing for the session after one
 * transient IPC hiccup. A failure also never clobbers an already-cached snapshot.
 */
export function loadOsEnvVars(): Promise<RuntimeEnv> {
  loadPromise ??= readOsEnvVars();
  return loadPromise;
}

async function readOsEnvVars(): Promise<RuntimeEnv> {
  if (!isTauri()) {
    cacheOsEnv({});
    return {};
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const env = await invoke<RuntimeEnv>("read_env_vars", {
      names: OS_ENV_VAR_NAMES,
    });
    cacheOsEnv(env);
    return env;
  } catch (error) {
    // Let a later call retry instead of memoizing the failure, and preserve any
    // previously cached values rather than clobbering them with an empty map.
    loadPromise = null;
    console.warn("[geolibre] Could not read OS environment variables for the AI assistant:", error);
    return readOsEnv();
  }
}

function cacheOsEnv(env: RuntimeEnv): void {
  if (typeof window !== "undefined") {
    (window as unknown as OsEnvWindow).__GEOLIBRE_OS_ENV__ = env;
  }
}
