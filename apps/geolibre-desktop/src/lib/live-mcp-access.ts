import type { SidecarServerInfo } from "./sidecar";

export interface LiveMcpAccessState {
  ready: SidecarServerInfo | null;
  enabled: boolean;
  error: boolean;
}

/** Synchronize relay access independently of processing startup, retrying failures. */
export function createLiveMcpAccessController(options: {
  getEnabled: () => boolean;
  send: (info: SidecarServerInfo, enabled: boolean) => Promise<void>;
  grants?: {
    get: (info: SidecarServerInfo) => boolean;
    set: (info: SidecarServerInfo, granted: boolean) => void;
  };
}) {
  let server: SidecarServerInfo | null = null;
  let generation = 0;
  let mayHaveGrantedAccess = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let queue = Promise.resolve();
  let state: LiveMcpAccessState = { ready: null, enabled: false, error: false };
  const listeners = new Set<(state: LiveMcpAccessState) => void>();

  const publish = (next: LiveMcpAccessState) => {
    if (state.ready === next.ready && state.enabled === next.enabled && state.error === next.error)
      return;
    state = next;
    for (const listener of listeners) notifyListener(listener);
  };
  const notifyListener = (listener: (state: LiveMcpAccessState) => void) => {
    try {
      listener(state);
    } catch (error) {
      console.error("Live MCP access listener failed", error);
    }
  };
  const clearRetry = () => {
    if (retry !== null) clearTimeout(retry);
    retry = null;
  };
  const sync = (): Promise<void> => {
    clearRetry();
    const enabled = options.getEnabled();
    // Revoke the app's subscription immediately, even when the server request
    // must wait behind an in-flight enable or fails before reaching the server.
    if (enabled !== state.enabled) publish({ ready: null, enabled, error: false });
    else if (!enabled && state.ready) publish({ ...state, ready: null });
    queue = queue.then(async () => {
      const info = server;
      if (!info) return;
      const mine = generation;
      const desired = options.getEnabled();
      if (!desired && !mayHaveGrantedAccess) {
        attempt = 0;
        publish({ ready: null, enabled: false, error: false });
        return;
      }
      // An enable may reach the server even if its response is lost. A later
      // opt-out must revoke that ambiguous grant, not only confirmed grants.
      if (desired) {
        mayHaveGrantedAccess = true;
        options.grants?.set(info, true);
      }
      try {
        await options.send(info, desired);
        if (mine !== generation || desired !== options.getEnabled()) return;
        attempt = 0;
        mayHaveGrantedAccess = desired;
        options.grants?.set(info, desired);
        publish({ ready: desired ? info : null, enabled: desired, error: false });
      } catch {
        if (mine !== generation || desired !== options.getEnabled()) return;
        publish({ ready: null, enabled: desired, error: true });
        retry = setTimeout(
          () => {
            retry = null;
            void sync();
          },
          Math.min(1000 * 2 ** attempt++, 15000),
        );
        // Node-based consumers should be able to exit while a background retry
        // is pending. Browser timers are numeric and need no such adjustment.
        if (typeof retry !== "number") retry.unref();
      }
    });
    return queue;
  };

  return {
    sync,
    setServer(info: SidecarServerInfo | null) {
      if (server?.baseUrl === info?.baseUrl && server?.token === info?.token) return;
      generation += 1;
      server = info;
      mayHaveGrantedAccess = info ? (options.grants?.get(info) ?? false) : false;
      attempt = 0;
      clearRetry();
      publish({ ready: null, enabled: options.getEnabled(), error: false });
    },
    subscribe(listener: (state: LiveMcpAccessState) => void) {
      listeners.add(listener);
      notifyListener(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
  };
}
