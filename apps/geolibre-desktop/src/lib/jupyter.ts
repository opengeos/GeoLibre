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

/**
 * Start (or reuse) the desktop JupyterLab server. Desktop-only — the web build
 * embeds the self-hosted JupyterLite site instead.
 */
export async function startJupyterServer(): Promise<JupyterServerInfo> {
  assertTauri();
  return invoke<JupyterServerInfo>("start_jupyter_server");
}

/** Stop the desktop JupyterLab server if it is running. */
export async function stopJupyterServer(): Promise<void> {
  assertTauri();
  await invoke("stop_jupyter_server");
}

function assertTauri(): void {
  if (!isTauri()) {
    throw new Error("Running a Jupyter server requires GeoLibre Desktop.");
  }
}
