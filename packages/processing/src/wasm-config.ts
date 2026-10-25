/**
 * Global and per-job WebAssembly runtime configuration for geoprocessing.
 */

import {
  getWasmCapabilities,
  resolveExecutionMode,
  type WasmDiagnostics,
  type WasmExecutionMode,
  type WasmRuntimeConfig,
} from "./wasm-capabilities";

let currentConfig: WasmRuntimeConfig = {
  executionMode: "auto",
  enableSIMD: true,
  enableThreads: true,
  debugPerformance: false,
};

/**
 * Update the global WebAssembly runtime configuration.
 */
export function setWasmRuntimeConfig(config: Partial<WasmRuntimeConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

/**
 * Retrieve the current WebAssembly runtime configuration.
 */
export function getWasmRuntimeConfig(): WasmRuntimeConfig {
  return { ...currentConfig };
}

/**
 * Reset WebAssembly runtime configuration to defaults.
 */
export function resetWasmRuntimeConfig(): void {
  currentConfig = {
    executionMode: "auto",
    enableSIMD: true,
    enableThreads: true,
    debugPerformance: false,
  };
}

/**
 * Produce an observable diagnostics snapshot describing active capabilities,
 * selected execution mode, thread count, and fallback reasons.
 */
export function getWasmDiagnostics(overrideConfig?: WasmRuntimeConfig): WasmDiagnostics {
  const cfg = overrideConfig ?? currentConfig;
  const capabilities = getWasmCapabilities();
  const resolution = resolveExecutionMode(cfg, capabilities);

  return {
    capabilities,
    activeMode: resolution.mode,
    requestedMode: cfg.executionMode ?? "auto",
    fallbackReason: resolution.fallbackReason,
    activeThreads: resolution.threads,
    timestamp: new Date().toISOString(),
  };
}
