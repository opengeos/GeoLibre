import { act, render, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { WindowCloseGuard } from "../apps/geolibre-desktop/src/hooks/useWindowCloseGuard";

const { useWindowCloseGuard } =
  await import("../apps/geolibre-desktop/src/hooks/useWindowCloseGuard");

type Callback = (payload: unknown) => void;

/** A stand-in for the Tauri IPC bridge: records commands, keeps callbacks. */
let ipc: {
  callbacks: Map<number, Callback>;
  commands: string[];
  closeHandlerId: number | null;
};

beforeEach(() => {
  ipc = { callbacks: new Map(), commands: [], closeHandlerId: null };
  let nextId = 1;
  // Unlistening on unmount goes through the event plugin's own global.
  (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: (callback: Callback) => {
      const id = nextId++;
      ipc.callbacks.set(id, callback);
      return id;
    },
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      ipc.commands.push(cmd);
      if (cmd === "plugin:event|listen") {
        if (args.event === "tauri://close-requested") ipc.closeHandlerId = args.handler as number;
        return 1;
      }
      return null;
    },
  };
});

// Yield first so the unmount's async unlisten still finds these globals.
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  delete (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__;
});

/** Render the hook and hand back a live view of its latest return value. */
function renderGuard(saveProject: () => Promise<boolean>): { current: WindowCloseGuard } {
  const result = {} as { current: WindowCloseGuard };
  function Probe() {
    result.current = useWindowCloseGuard(saveProject);
    return null;
  }
  render(createElement(Probe));
  return result;
}

/** Fire the native title-bar close, as Tauri emits it to the webview. */
async function requestClose(): Promise<void> {
  await waitFor(() => assert.notEqual(ipc.closeHandlerId, null));
  const handler = ipc.callbacks.get(ipc.closeHandlerId as number);
  await act(async () => {
    handler?.({ event: "tauri://close-requested", id: 1, payload: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const destroyed = () => ipc.commands.includes("plugin:window|destroy");

describe("useWindowCloseGuard", () => {
  it("closes a clean project without asking", async () => {
    const guard = renderGuard(async () => true);
    await requestClose();
    assert.equal(guard.current.windowClosePromptOpen, false);
    assert.ok(destroyed());
  });

  it("holds a dirty window open and asks first", async () => {
    useAppStore.setState({ isDirty: true });
    const guard = renderGuard(async () => true);
    await requestClose();
    assert.equal(guard.current.windowClosePromptOpen, true);
    assert.ok(!destroyed());
  });

  it("keeps the window on cancel", async () => {
    useAppStore.setState({ isDirty: true });
    const guard = renderGuard(async () => true);
    await requestClose();
    await act(() => guard.current.resolveWindowClosePrompt("cancel"));
    assert.equal(guard.current.windowClosePromptOpen, false);
    assert.ok(!destroyed());
  });

  it("closes without saving on discard", async () => {
    useAppStore.setState({ isDirty: true });
    let saves = 0;
    const guard = renderGuard(async () => {
      saves += 1;
      return true;
    });
    await requestClose();
    await act(() => guard.current.resolveWindowClosePrompt("discard"));
    assert.equal(saves, 0);
    assert.ok(destroyed());
  });

  it("saves, then closes", async () => {
    useAppStore.setState({ isDirty: true });
    let saves = 0;
    const guard = renderGuard(async () => {
      saves += 1;
      useAppStore.setState({ isDirty: false });
      return true;
    });
    await requestClose();
    await act(() => guard.current.resolveWindowClosePrompt("save"));
    assert.equal(saves, 1);
    assert.ok(destroyed());
  });

  it("keeps the window when the project is still dirty after saving", async () => {
    useAppStore.setState({ isDirty: true });
    // Reports success, but an edit landed during the write so nothing was marked saved.
    const guard = renderGuard(async () => true);
    await requestClose();
    await act(() => guard.current.resolveWindowClosePrompt("save"));
    assert.ok(!destroyed());
  });

  it("does not discard a project that replaced the one the prompt asked about", async () => {
    useAppStore.setState({ isDirty: true });
    const guard = renderGuard(async () => true);
    await requestClose();
    act(() => {
      useAppStore.setState((s) => ({ projectGeneration: s.projectGeneration + 1 }));
    });
    await act(() => guard.current.resolveWindowClosePrompt("discard"));
    assert.equal(guard.current.windowClosePromptOpen, false);
    assert.ok(!destroyed());
  });

  it("does not rebind an open prompt when the window is closed again", async () => {
    useAppStore.setState({ isDirty: true });
    const guard = renderGuard(async () => true);
    await requestClose();
    // A dirty project replaces the one the prompt asked about, then X again.
    act(() => {
      useAppStore.setState((s) => ({ projectGeneration: s.projectGeneration + 1 }));
    });
    await requestClose();
    await act(() => guard.current.resolveWindowClosePrompt("discard"));
    assert.ok(!destroyed());
  });

  it("keeps the window when the save is cancelled or fails, and asks on the next close", async () => {
    useAppStore.setState({ isDirty: true });
    const guard = renderGuard(async () => false);
    await requestClose();
    await act(() => guard.current.resolveWindowClosePrompt("save"));
    // Closed so a failed save's error dialog is not hidden under it.
    assert.equal(guard.current.windowClosePromptOpen, false);
    assert.ok(!destroyed());
    await requestClose();
    assert.equal(guard.current.windowClosePromptOpen, true);
  });
});
