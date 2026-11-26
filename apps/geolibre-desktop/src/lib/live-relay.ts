import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import i18next from "i18next";
import { useDesktopSettingsStore } from "../hooks/useDesktopSettings";
import {
  type RelayCommand,
  encodeRelayResult,
  parseRelayCommand,
  runRelayCommand,
} from "./jupyter-relay";
import { dismissNotification, notify } from "./notify";
import type { ScriptingHandlers } from "./scripting/scriptingApi";

// The app side of the Live MCP relay the desktop shell hosts itself
// (src-tauri/src/live_relay.rs). The shell serves the MCP client over loopback
// HTTP (a Unix socket in the Mac App Store build) and hands each command to the
// webview as a Tauri event; the webview runs it against the same scripting
// handlers as the Jupyter relay and returns the result through a command. No
// Python sidecar or Jupyter server is involved, so every desktop build, the
// sandboxed Mac App Store one included, can be driven by the live tools.

/** Tauri event a subscribed webview receives each relayed command on (`COMMAND_EVENT`). */
export const LIVE_RELAY_COMMAND_EVENT = "live-relay:command";

/** Where the shell's relay access stands, as the app last confirmed it. */
export interface LiveRelayAccessState {
  /** The user's preference being applied. */
  enabled: boolean;
  /** Access is confirmed on, so the webview may subscribe. */
  ready: boolean;
  /** The last attempt to apply the preference failed and is being retried. */
  error: boolean;
}

/**
 * Keep the shell's relay access in step with the user's preference.
 *
 * Every sync sends the desired state (an in-process call, so a reloaded
 * renderer always reasserts it), revokes the webview's subscription before
 * the shell confirms an opt-out, and retries failures with backoff.
 *
 * @param options - Reads the preference and applies it to the shell.
 * @returns The controller.
 */
export function createLiveRelayAccessController(options: {
  getEnabled: () => boolean;
  send: (enabled: boolean) => Promise<void>;
}) {
  let state: LiveRelayAccessState = { enabled: false, ready: false, error: false };
  let generation = 0;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let queue = Promise.resolve();
  const listeners = new Set<(state: LiveRelayAccessState) => void>();

  const notifyListener = (listener: (state: LiveRelayAccessState) => void) => {
    try {
      listener(state);
    } catch (error) {
      console.error("Live MCP access listener failed", error);
    }
  };
  const publish = (next: LiveRelayAccessState) => {
    if (state.enabled === next.enabled && state.ready === next.ready && state.error === next.error)
      return;
    state = next;
    for (const listener of listeners) notifyListener(listener);
  };
  const clearRetry = () => {
    if (retry !== null) clearTimeout(retry);
    retry = null;
  };

  const sync = (): Promise<void> => {
    clearRetry();
    const desired = options.getEnabled();
    const mine = ++generation;
    // Stop handling commands at once on an opt-out, before the shell answers.
    // A retry of the same preference keeps its error, so a persistent
    // notice does not flicker on every attempt.
    if (desired !== state.enabled || state.ready) {
      publish({ enabled: desired, ready: false, error: state.error && desired === state.enabled });
    }
    queue = queue.then(async () => {
      if (mine !== generation) return;
      try {
        await options.send(desired);
        if (mine !== generation) return;
        attempt = 0;
        publish({ enabled: desired, ready: desired, error: false });
      } catch (error) {
        if (mine !== generation) return;
        console.warn("Live MCP: could not apply the access setting", error);
        publish({ enabled: desired, ready: false, error: true });
        retry = setTimeout(
          () => {
            retry = null;
            void sync();
          },
          Math.min(1000 * 2 ** attempt++, 15000),
        );
        // Let Node-based consumers exit while a retry is pending.
        if (typeof retry !== "number") retry.unref();
      }
    });
    return queue;
  };

  return {
    sync,
    subscribe(listener: (state: LiveRelayAccessState) => void): () => void {
      listeners.add(listener);
      notifyListener(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    /** Stop retrying (tests and teardown). */
    dispose: () => {
      generation += 1;
      clearRetry();
    },
  };
}

const access = createLiveRelayAccessController({
  getEnabled: () => useDesktopSettingsStore.getState().desktopSettings.startup.allowLiveMcp,
  send: async (enabled) => {
    await invoke("live_relay_set_access", { enabled });
  },
});
let accessNotice: string | null = null;
access.subscribe((state) => {
  if (!state.error && accessNotice) {
    dismissNotification(accessNotice);
    accessNotice = null;
  }
  if (state.error && !accessNotice) {
    accessNotice = notify.warning(
      i18next.t(
        state.enabled ? "notifications.liveMcpEnableRetry" : "notifications.liveMcpDisableRetry",
      ),
      { durationMs: null, pinned: true, dedupeKey: "live-mcp-access" },
    );
  }
});

/** Apply the current "Allow AI agents to drive the map" setting to the shell. */
export function updateLiveRelayAccess(): Promise<void> {
  return access.sync();
}

/** Follow whether the webview may subscribe (access confirmed on). */
export function subscribeLiveRelayReady(listener: (ready: boolean) => void): () => void {
  return access.subscribe((state) => listener(state.ready));
}

/** The Tauri calls {@link connectLiveRelay} makes, injectable for tests. */
export interface LiveRelayTransport {
  listen: (handler: (payload: unknown) => void) => Promise<UnlistenFn>;
  subscribe: () => Promise<unknown>;
  unsubscribe: () => Promise<unknown>;
  reply: (frame: string) => Promise<unknown>;
}

/** The real transport: Tauri events in, commands out. */
export const tauriLiveRelayTransport: LiveRelayTransport = {
  listen: (handler) => listen<unknown>(LIVE_RELAY_COMMAND_EVENT, (event) => handler(event.payload)),
  subscribe: () => invoke("live_relay_subscribe"),
  unsubscribe: () => invoke("live_relay_unsubscribe"),
  reply: (frame) => invoke("live_relay_result", { frame }),
};

/**
 * Run relayed commands while access is confirmed, and stop the moment it is not.
 *
 * @param ready - Lifecycle source reporting whether access is confirmed.
 * @param handlers - The scripting command surface.
 * @param transport - The Tauri calls to use.
 * @returns A cleanup function that unsubscribes the webview.
 */
export function connectLiveRelay(
  ready: (listener: (ready: boolean) => void) => () => void,
  handlers: ScriptingHandlers,
  transport: LiveRelayTransport = tauriLiveRelayTransport,
): () => void {
  let generation = 0;
  let unlisten: UnlistenFn | null = null;
  // A subscribe has been queued for the shell and not yet undone.
  let subscribed = false;
  // The shell keys subscriptions by window label only, so subscribe and
  // unsubscribe calls run strictly in order: a stale generation's unsubscribe
  // must land before a newer generation subscribes, never after it.
  let shellCalls: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(call: () => Promise<T>): Promise<T> => {
    const next = shellCalls.then(
      () => call(),
      () => call(),
    );
    shellCalls = next.catch(() => {});
    return next;
  };

  const run = async (command: RelayCommand, mine: number) => {
    const result = await runRelayCommand(handlers, command);
    // A command that finishes after an opt-out is not reported back.
    if (!result || mine !== generation) return;
    try {
      await transport.reply(encodeRelayResult(result));
    } catch (error) {
      console.warn("Live MCP relay: could not return a command result", error);
    }
  };

  const stop = () => {
    generation += 1;
    unlisten?.();
    unlisten = null;
    if (subscribed) {
      subscribed = false;
      inOrder(transport.unsubscribe).catch(() => {
        // The shell drops every subscriber itself when access is revoked.
      });
    }
  };

  let retry: ReturnType<typeof setTimeout> | null = null;
  const clearRetry = () => {
    if (retry !== null) clearTimeout(retry);
    retry = null;
  };

  const unsubscribe = ready((isReady) => {
    stop();
    clearRetry();
    if (!isReady) return;
    const mine = generation;
    let attempt = 0;
    const attach = async () => {
      try {
        const remove = await transport.listen((payload) => {
          if (mine !== generation) return;
          const command = parseRelayCommand(payload);
          if (command) void run(command, mine);
        });
        if (mine !== generation) {
          remove();
          return;
        }
        unlisten = remove;
        // Marked before the call resolves, so a stop() meanwhile queues its
        // unsubscribe right behind this subscribe, ahead of any newer one.
        subscribed = true;
        await inOrder(transport.subscribe);
      } catch (error) {
        console.warn("Live MCP relay: could not subscribe this window", error);
        if (mine !== generation) return;
        // Undo the partial attach and try again, so a transient shell failure
        // cannot leave the relay silently dead while access reads as on.
        unlisten?.();
        unlisten = null;
        subscribed = false;
        retry = setTimeout(
          () => {
            retry = null;
            if (mine === generation) void attach();
          },
          Math.min(1000 * 2 ** attempt++, 15000),
        );
        if (typeof retry !== "number") retry.unref();
      }
    };
    void attach();
  });

  return () => {
    unsubscribe();
    clearRetry();
    stop();
  };
}
