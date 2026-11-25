import { useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { renderHook } from "@testing-library/react";
import { createEmptyProject, type GeoLibreProject } from "@geolibre/core";
import { geojsonLayer } from "./helpers/layer-fixtures";
import { clearNotifications, useNotificationStore } from "../apps/geolibre-desktop/src/lib/notify";
import type { ServerMessage } from "../apps/geolibre-desktop/src/lib/collab-protocol";

const { useCollaboration } = await import("../apps/geolibre-desktop/src/hooks/useCollaboration");
const originalWebSocket = globalThis.WebSocket;
let socket: FakeSocket;

class FakeSocket {
  static readonly OPEN = 1;
  readyState = 0;
  closed = false;
  sent: string[] = [];
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  constructor() {
    socket = this;
  }
  addEventListener(type: string, callback: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(callback);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    for (const callback of this.listeners.open ?? []) callback({});
  }
  message(message: ServerMessage) {
    for (const callback of this.listeners.message ?? [])
      callback({ data: JSON.stringify(message) });
  }
}

const suffix = "/Library/Application Support/org.geolibre.app/picked-documents";
const oldRoot = `/private/var/mobile/Containers/Data/Application/old${suffix}`;
const root = `/private/var/mobile/Containers/Data/Application/current${suffix}`;
const relative = "/3cb9b477-d563-4d3e-8503-263ec23c01c5/data/roads.geojson";
const failure = "Imported-file access is unavailable.";

function retainedProject(): GeoLibreProject {
  return {
    ...createEmptyProject("Retained"),
    layers: [geojsonLayer({ sourcePath: oldRoot + relative })],
  };
}

function welcome(snapshot: GeoLibreProject): ServerMessage {
  return {
    type: "welcome",
    clientId: "guest",
    role: "guest",
    mode: "co-edit",
    participants: [],
    presence: {},
    chat: [],
    snapshot,
    rev: 0,
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeSocket,
  });
  Object.assign(window, {
    __GEOLIBRE_DEPLOYMENT_ENV__: { VITE_GEOLIBRE_COLLAB_URL: "wss://relay.example" },
  });
  useAppStore.getState().setNativeDocumentCopyRoot(null);
  useAppStore
    .getState()
    .newProject({ name: "Keep local", layers: [geojsonLayer({ id: "local" })] });
  useAppStore.getState().resetCollaboration();
  clearNotifications();
});

afterEach(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: originalWebSocket,
  });
  Reflect.deleteProperty(window, "__GEOLIBRE_DEPLOYMENT_ENV__");
  useAppStore.getState().setNativeDocumentCopyRoot(null);
  useAppStore.getState().resetCollaboration();
  clearNotifications();
});

it("rejects an unavailable initial snapshot without hanging the join or publishing local data", async () => {
  useAppStore.getState().setNativeDocumentCopyError(failure);
  const before = useAppStore.getState();
  const hook = renderHook(() => useCollaboration({ current: null }, 0));
  try {
    const rejected = assert.rejects(
      hook.result.current.join("ABC", "Guest", "#ff0000"),
      /Imported-file access/,
    );
    socket.open();
    assert.doesNotThrow(() => socket.message(welcome(retainedProject())));
    await rejected;
    const after = useAppStore.getState();
    assert.equal(after.layers === before.layers, true);
    assert.equal(after.projectGeneration, before.projectGeneration);
    assert.equal(after.collaboration.isActive, false);
    assert.equal(after.collaboration.connecting, false);
    assert.equal(after.collaboration.error, failure);
    assert.equal(socket.closed, true);
    assert.equal(
      socket.sent.some((frame) => JSON.parse(frame).type === "snapshot"),
      false,
    );
    assert.equal(useNotificationStore.getState().notifications[0].message, failure);
  } finally {
    hook.unmount();
  }
});

it("settles an unexpected snapshot application failure with its original error", async () => {
  const original = useAppStore.getState().loadProject;
  const applyFailure = new Error("Unexpected project application failure");
  useAppStore.setState({
    loadProject: () => {
      throw applyFailure;
    },
  });
  const before = useAppStore.getState();
  const hook = renderHook(() => useCollaboration({ current: null }, 0));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const joined = hook.result.current.join("ABC", "Guest", "#ff0000");
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Join did not settle")), 1000);
    });
    const rejected = assert.rejects(
      Promise.race([joined, deadline]),
      (error: Error) => error === applyFailure,
    );
    socket.open();
    assert.doesNotThrow(() => socket.message(welcome(createEmptyProject("Remote"))));
    await rejected;
    assert.equal(useAppStore.getState().layers, before.layers);
    assert.equal(useAppStore.getState().collaboration.error, applyFailure.message);
    assert.equal(socket.closed, true);
    assert.equal(useNotificationStore.getState().notifications[0].message, applyFailure.message);
    assert.equal(
      socket.sent.some((frame) => JSON.parse(frame).type === "snapshot"),
      false,
    );
  } finally {
    clearTimeout(timer);
    hook.unmount();
    useAppStore.setState({ loadProject: original });
  }
});

it("preserves unrelated chat error behavior without disconnecting the session", async () => {
  const original = useAppStore.getState().addCollaborationChat;
  const chatFailure = new Error("Unexpected chat application failure");
  const hook = renderHook(() => useCollaboration({ current: null }, 0));
  try {
    const joined = hook.result.current.join("ABC", "Guest", "#ff0000");
    socket.open();
    socket.message(welcome(createEmptyProject("Session")));
    await joined;
    useAppStore.setState({
      addCollaborationChat: () => {
        throw chatFailure;
      },
    });
    assert.throws(
      () =>
        socket.message({
          type: "chat",
          message: {
            id: "chat-1",
            clientId: "host",
            displayName: "Host",
            color: "#ff0000",
            text: "Hello",
            ts: 1,
          },
        }),
      (error: Error) => error === chatFailure,
    );
    assert.equal(socket.closed, false);
    assert.equal(useAppStore.getState().collaboration.isActive, true);
    assert.equal(useAppStore.getState().collaboration.error, null);
    assert.equal(useNotificationStore.getState().notifications.length, 0);
  } finally {
    useAppStore.setState({ addCollaborationChat: original });
    hook.unmount();
  }
});

it("disconnects before a later unavailable snapshot can replace the open project", async () => {
  const hook = renderHook(() => useCollaboration({ current: null }, 0));
  try {
    const joined = hook.result.current.join("ABC", "Guest", "#ff0000");
    socket.open();
    socket.message(welcome(createEmptyProject("Session")));
    await joined;
    useAppStore.getState().setNativeDocumentCopyError(failure);
    const before = useAppStore.getState();
    socket.message({ type: "snapshot", origin: "guest", rev: 1, project: retainedProject() });
    assert.equal(socket.closed, false, "the relay's echo of our own frame is ignored");
    assert.equal(useAppStore.getState().layers === before.layers, true);
    assert.doesNotThrow(() =>
      socket.message({ type: "snapshot", origin: "host", rev: 1, project: retainedProject() }),
    );
    const after = useAppStore.getState();
    assert.equal(after.layers === before.layers, true);
    assert.equal(after.projectGeneration, before.projectGeneration);
    assert.equal(after.collaboration.isActive, false);
    assert.equal(socket.closed, true);
    assert.equal(
      socket.sent.some((frame) => JSON.parse(frame).type === "snapshot"),
      false,
    );
  } finally {
    hook.unmount();
  }
});

it("rebases retained references in later snapshots before publishing them", async () => {
  useAppStore.getState().setNativeDocumentCopyRoot(root);
  const hook = renderHook(() => useCollaboration({ current: null }, 0));
  try {
    const joined = hook.result.current.join("ABC", "Guest", "#ff0000");
    socket.open();
    socket.message(welcome(createEmptyProject("Session")));
    await joined;
    const project = retainedProject();
    socket.message({ type: "snapshot", origin: "host", rev: 1, project });
    assert.equal(useAppStore.getState().layers[0].sourcePath, root + relative);
    assert.equal(project.layers[0].sourcePath, oldRoot + relative);
    assert.equal(socket.closed, false);
  } finally {
    hook.unmount();
  }
});
