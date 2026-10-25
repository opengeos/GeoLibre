/**
 * WebAssembly capabilities probe and execution mode resolution.
 *
 * Distinguishes between:
 *  - Browser capabilities (WASM, SIMD128, SharedArrayBuffer, crossOriginIsolated, hardwareConcurrency)
 *  - Available WebAssembly execution modes:
 *      1. "threaded-simd": Multi-worker parallel execution with SIMD128
 *      2. "simd-single-thread": Single-worker execution with SIMD128
 *      3. "portable-single-thread": Single-worker portable baseline fallback
 */

export type WasmExecutionMode = "threaded-simd" | "simd-single-thread" | "portable-single-thread";

export interface WasmCapabilities {
  /** True if the host environment supports WebAssembly. */
  hasWasm: boolean;
  /** True if WebAssembly SIMD128 instructions are supported and validate. */
  hasSimd: boolean;
  /** True if SharedArrayBuffer is defined in the global scope. */
  hasSharedArrayBuffer: boolean;
  /** True if WebAssembly shared memory (atomics/threads) is supported. */
  hasSharedMemory: boolean;
  /** True if the execution context is cross-origin isolated. */
  isCrossOriginIsolated: boolean;
  /** Number of logical CPU cores reported by navigator.hardwareConcurrency (or 1). */
  hardwareConcurrency: number;
  /** Safe recommended thread count clamped between 1 and 16. */
  recommendedThreads: number;
}

export interface WasmRuntimeConfig {
  /** Desired execution mode ("auto" detects best available). */
  executionMode?: "auto" | WasmExecutionMode;
  /** Upper bound on worker pool size in threaded mode. */
  maxThreads?: number;
  /** Whether SIMD-enabled modes are allowed. Defaults to true. */
  enableSIMD?: boolean;
  /** Whether multi-worker threaded modes are allowed. Defaults to true. */
  enableThreads?: boolean;
  /** Enable verbose timing and diagnostic logging. Defaults to false. */
  debugPerformance?: boolean;
}

export interface WasmDiagnostics {
  capabilities: WasmCapabilities;
  activeMode: WasmExecutionMode;
  requestedMode: string;
  fallbackReason?: string;
  activeThreads: number;
  timestamp: string;
}

// Minimal valid WebAssembly module testing v128.const SIMD128 opcode (0xfd 0x0c)
const SIMD128_TEST_BYTECODE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, 0x03,
  0x02, 0x01, 0x00, 0x0a, 0x16, 0x01, 0x14, 0x00, 0xfd, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0b,
]);

// Minimal valid WebAssembly module with shared memory declaration (memory 1 2 shared)
const SHARED_MEMORY_TEST_BYTECODE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x04, 0x01, 0x03, 0x01, 0x02, 0x07, 0x0a,
  0x01, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
]);

let cachedSimdSupport: boolean | null = null;
let cachedSharedMemorySupport: boolean | null = null;

/**
 * Probe whether WebAssembly SIMD128 is supported by the runtime engine.
 * Cached after first check.
 */
export function detectSimdSupport(): boolean {
  if (cachedSimdSupport !== null) return cachedSimdSupport;
  try {
    if (typeof WebAssembly !== "object" || typeof WebAssembly.validate !== "function") {
      cachedSimdSupport = false;
      return false;
    }
    cachedSimdSupport = WebAssembly.validate(SIMD128_TEST_BYTECODE);
  } catch {
    cachedSimdSupport = false;
  }
  return cachedSimdSupport;
}

/**
 * Probe whether WebAssembly shared memory is supported.
 * Cached after first check.
 */
export function detectSharedMemorySupport(): boolean {
  if (cachedSharedMemorySupport !== null) return cachedSharedMemorySupport;
  try {
    if (typeof WebAssembly !== "object" || typeof WebAssembly.validate !== "function") {
      cachedSharedMemorySupport = false;
      return false;
    }
    cachedSharedMemorySupport = WebAssembly.validate(SHARED_MEMORY_TEST_BYTECODE);
  } catch {
    cachedSharedMemorySupport = false;
  }
  return cachedSharedMemorySupport;
}

/**
 * Reset cached probes (useful for testing different environments).
 */
export function resetWasmCapabilitiesCache(): void {
  cachedSimdSupport = null;
  cachedSharedMemorySupport = null;
}

let mockWasmCapabilities: Partial<WasmCapabilities> | null = null;

/**
 * Override capability detection for unit testing or controlled simulation.
 */
export function setMockWasmCapabilities(caps: Partial<WasmCapabilities> | null): void {
  mockWasmCapabilities = caps;
}

/**
 * Read the full set of current host capabilities.
 */
export function getWasmCapabilities(): WasmCapabilities {
  const hasWasm = typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
  const hasSimd = hasWasm && detectSimdSupport();
  const hasSharedArrayBuffer = typeof SharedArrayBuffer !== "undefined";
  const hasSharedMemory = hasWasm && detectSharedMemorySupport();
  const isCrossOriginIsolated = Boolean(globalThis.crossOriginIsolated);

  // Without navigator (non-browser hosts) assume no parallelism.
  let rawConcurrency = 1;
  if (typeof navigator === "object" && typeof navigator.hardwareConcurrency === "number") {
    rawConcurrency = navigator.hardwareConcurrency;
  }
  // Clamp hardwareConcurrency: at least 1, conservative upper bound of 16
  const hardwareConcurrency = Math.max(1, Math.min(16, rawConcurrency));
  // Default recommendation: one thread per core, capped at 4
  const recommendedThreads = Math.max(1, Math.min(hardwareConcurrency, 4));

  const base: WasmCapabilities = {
    hasWasm,
    hasSimd,
    hasSharedArrayBuffer,
    hasSharedMemory,
    isCrossOriginIsolated,
    hardwareConcurrency,
    recommendedThreads,
  };

  return mockWasmCapabilities ? { ...base, ...mockWasmCapabilities } : base;
}

/**
 * Resolve the execution mode and worker pool thread count given a configuration.
 *
 * Precedence Order:
 *  1. "threaded-simd" if requested/auto, SIMD is enabled & supported, and threading conditions are met.
 *  2. "simd-single-thread" if requested/auto, SIMD is enabled & supported.
 *  3. "portable-single-thread" as universal safe fallback.
 */
export function resolveExecutionMode(
  config: WasmRuntimeConfig = {},
  caps: WasmCapabilities = getWasmCapabilities(),
): { mode: WasmExecutionMode; threads: number; fallbackReason?: string } {
  const requested = config.executionMode ?? "auto";
  const enableSIMD = config.enableSIMD ?? true;
  const enableThreads = config.enableThreads ?? true;
  // A non-finite thread count (NaN from a bad config or capability) would make
  // the pool capacity NaN and stall every queued job, so fall back to 1.
  const rawThreads = config.maxThreads ?? caps.recommendedThreads;
  const maxThreads = Number.isFinite(rawThreads)
    ? Math.max(1, Math.min(16, Math.floor(rawThreads)))
    : 1;

  const canThread =
    enableThreads &&
    caps.hasSharedArrayBuffer &&
    caps.isCrossOriginIsolated &&
    caps.hasSharedMemory;

  const canSimd = enableSIMD && caps.hasSimd;

  function getThreadFallbackReason(): string {
    if (!enableThreads) return "Multi-threading disabled by configuration.";
    if (!caps.isCrossOriginIsolated) {
      return "Cross-origin isolation (COOP/COEP) is not enabled on this document; multithreading disabled.";
    }
    if (!caps.hasSharedArrayBuffer) {
      return "SharedArrayBuffer is unavailable in this environment; multithreading disabled.";
    }
    if (!caps.hasSharedMemory) {
      return "WebAssembly shared memory is not supported; multithreading disabled.";
    }
    return "Threading prerequisites not satisfied.";
  }

  function getSimdFallbackReason(): string {
    if (!enableSIMD) return "WebAssembly SIMD128 disabled by configuration.";
    if (!caps.hasSimd) return "WebAssembly SIMD128 is not supported by this engine.";
    return "SIMD prerequisites not satisfied.";
  }

  if (requested === "threaded-simd") {
    if (!canSimd) {
      return {
        mode: "portable-single-thread",
        threads: 1,
        fallbackReason: `Explicitly requested threaded-simd, but ${getSimdFallbackReason()}`,
      };
    }
    if (!canThread) {
      return {
        mode: "simd-single-thread",
        threads: 1,
        fallbackReason: `Explicitly requested threaded-simd, but ${getThreadFallbackReason()}`,
      };
    }
    return { mode: "threaded-simd", threads: maxThreads };
  }

  if (requested === "simd-single-thread") {
    if (!canSimd) {
      return {
        mode: "portable-single-thread",
        threads: 1,
        fallbackReason: `Explicitly requested simd-single-thread, but ${getSimdFallbackReason()}`,
      };
    }
    return { mode: "simd-single-thread", threads: 1 };
  }

  if (requested === "portable-single-thread") {
    return { mode: "portable-single-thread", threads: 1 };
  }

  // Automatic selection
  if (canSimd && canThread) {
    return { mode: "threaded-simd", threads: maxThreads };
  }
  if (canSimd) {
    return {
      mode: "simd-single-thread",
      threads: 1,
      fallbackReason: !canThread ? getThreadFallbackReason() : undefined,
    };
  }

  return {
    mode: "portable-single-thread",
    threads: 1,
    fallbackReason: !canSimd ? getSimdFallbackReason() : "Using portable baseline mode.",
  };
}
