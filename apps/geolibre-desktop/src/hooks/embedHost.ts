// Shared embed-host plumbing for the postMessage bridges that connect the app to
// an embedding host (the GeoLibre Python widget / `to_html()` export). Both the
// project-state bridge (useEmbedBridge) and the scripting command bridge
// (useCommandBridge) talk to the SAME host window and must apply the SAME trust
// rules, so the detection and origin handshake live here once.

/**
 * Detects whether the app is running inside the GeoLibre Jupyter/embed host.
 *
 * The app is considered embedded when it is framed (a different `window.parent`)
 * or when it is opened with an explicit `?embed=1` query parameter, which lets
 * the host force the bridge on for a standalone `to_html()` export.
 *
 * @returns True when the postMessage bridges should be active.
 */
export function isEmbedded(): boolean {
  if (typeof window === "undefined") return false;
  // An explicit opt-in always activates the bridge — this is how the Jupyter
  // widget and `to_html()` exports run (they load the app with `?embed=1`).
  const embed = new URLSearchParams(window.location.search).get("embed");
  if (embed === "1" || embed === "true") return true;
  try {
    // A same-origin framing host (readable parent) is trusted, so activate.
    return Boolean(window.parent && window.parent !== window);
  } catch {
    // A cross-origin parent throws on access. Without the explicit `?embed=1`
    // opt-in, don't activate the bridge — otherwise any third-party page that
    // iframes a deployed app would start receiving project state.
    return false;
  }
}

/**
 * Per-bridge handshake state with the embedding host.
 *
 * The host is the embedding parent window. Outbound messages are scoped to the
 * host's origin once it is learned from the host's first message; until then
 * (only a version-only `ready` ping precedes the handshake) `targetOrigin`
 * falls back to `"*"`. `handshakeComplete` gates proactive broadcasts so a
 * third-party page that frames a `?embed=1` export but never speaks never
 * receives data.
 */
export interface EmbedHost {
  /** The embedding parent window (or `window` itself for a top-level export). */
  readonly window: Window;
  /** Whether the host has sent at least one message. */
  readonly handshakeComplete: boolean;
  /** Origin to scope outbound posts to (`"*"` until the host is identified). */
  targetOrigin(): string;
  /**
   * Record an inbound message from the host: marks the handshake complete and
   * learns the host's origin. Returns true when the message actually came from
   * the host window (callers should ignore messages where this is false).
   */
  note(event: MessageEvent): boolean;
}

/**
 * Create the shared host channel for a bridge. In a browser `window.parent` is
 * always defined; when the app is the top-level document (the `?embed=1`
 * self-test) it is `window` itself, so the bridge naturally posts to and
 * receives from itself.
 */
export function createEmbedHost(): EmbedHost {
  const host = window.parent;
  let hostOrigin: string | null = null;
  let handshakeComplete = false;
  return {
    window: host,
    get handshakeComplete() {
      return handshakeComplete;
    },
    targetOrigin: () => hostOrigin ?? "*",
    note(event: MessageEvent): boolean {
      if (event.source !== host) return false;
      handshakeComplete = true;
      // "null" (opaque/file origins) stays "*".
      if (event.origin && event.origin !== "null") hostOrigin = event.origin;
      return true;
    },
  };
}

// Both bridges talk to the SAME parent window, so they share one host channel:
// whichever bridge sees the host's first message learns the origin and marks the
// handshake for both. This lets the command bridge emit events with the correct
// scoped origin once the project bridge has completed its (reliable) handshake,
// without each bridge needing its own round-trip first.
let shared: EmbedHost | null = null;

/** The process-wide shared {@link EmbedHost}, created lazily on first use. */
export function getEmbedHost(): EmbedHost {
  if (!shared) shared = createEmbedHost();
  return shared;
}
