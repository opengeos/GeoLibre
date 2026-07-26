import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./is-tauri";

/**
 * Connection details for the desktop JupyterLab server, returned by the Tauri
 * `start_jupyter_server` command. The server is uv-managed (like the FastAPI
 * sidecar) and bound to loopback; `token` authenticates the embedded iframe.
 */
export interface JupyterServerInfo {
  /** Base URL, e.g. `http://127.0.0.1:8766`. */
  url: string;
  port: number;
  /** Auth token to append as `?token=…` to the embedded URL. */
  token: string;
}

// The live server, published so app-level consumers (the map-command relay in
// useJupyterRelay) can reach it without depending on the Notebook panel, which
// owns the *starting* of the server but may be closed while it keeps running.
let liveServer: JupyterServerInfo | null = null;
const serverListeners = new Set<(info: JupyterServerInfo | null) => void>();

/** The running desktop JupyterLab server, or null when none has been started. */
export function getJupyterServer(): JupyterServerInfo | null {
  return liveServer;
}

/**
 * Observe the desktop JupyterLab server's lifecycle.
 *
 * @param listener - Called with the current server (or null) immediately, then
 *   on every start/stop.
 * @returns An unsubscribe function.
 */
export function subscribeJupyterServer(
  listener: (info: JupyterServerInfo | null) => void,
): () => void {
  serverListeners.add(listener);
  listener(liveServer);
  return () => {
    serverListeners.delete(listener);
  };
}

function setJupyterServer(info: JupyterServerInfo | null): void {
  liveServer = info;
  for (const listener of serverListeners) listener(info);
}

/**
 * Start (or reuse) the desktop JupyterLab server. Desktop-only — the web build
 * embeds the self-hosted JupyterLite site instead.
 */
export async function startJupyterServer(): Promise<JupyterServerInfo> {
  assertTauri();
  const info = await invoke<JupyterServerInfo>("start_jupyter_server");
  setJupyterServer(info);
  return info;
}

/** Stop the desktop JupyterLab server if it is running. */
export async function stopJupyterServer(): Promise<void> {
  assertTauri();
  await invoke("stop_jupyter_server");
  setJupyterServer(null);
}

function assertTauri(): void {
  if (!isTauri()) {
    throw new Error("Running a Jupyter server requires GeoLibre Desktop.");
  }
}
