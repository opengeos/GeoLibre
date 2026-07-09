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
 * The result is memoized: the first call performs the read and every later call
 * returns the same snapshot without re-invoking the backend. A failed read is
 * swallowed to an empty map (a missing capability must never block startup) and,
 * crucially, does **not** overwrite an already-cached successful snapshot.
 */
export function loadOsEnvVars(): Promise<RuntimeEnv> {
  loadPromise ??= (async () => {
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
    } catch {
      // Preserve any previously cached values rather than clobbering them with
      // an empty map on a transient IPC failure.
      return readOsEnv();
    }
  })();
  return loadPromise;
}

function cacheOsEnv(env: RuntimeEnv): void {
  if (typeof window !== "undefined") {
    (window as unknown as OsEnvWindow).__GEOLIBRE_OS_ENV__ = env;
  }
}
