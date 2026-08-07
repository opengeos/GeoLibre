import {
  applyProjectToStore,
  clearHistory,
  serializeProject,
  useAppStore,
  type CollaborationMode,
  type CollaborationParticipant,
  type CollaborationPresence,
  type GeoLibreProject,
} from "@geolibre/core";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";
import type { MapController } from "@geolibre/map";
import type { Map as MapLibreMap } from "maplibre-gl";
import i18n from "../i18n";
import {
  buildCollaborationSnapshot,
  buildProjectEgressSnapshot,
} from "../lib/build-project-snapshot";
import { projectChanged } from "../lib/project-broadcast-changed";
import {
  CollabConnection,
  createSession,
  resolveCollabBaseUrl,
  sessionWsUrl,
} from "../lib/collab-client";
import type { CommentMutationAction, ServerMessage } from "../lib/collab-protocol";
import { mergeInboundCollaborationProject } from "../lib/collaboration-project";

const SNAPSHOT_DEBOUNCE_MS = 250;
const CURSOR_THROTTLE_MS = 40;

export interface CollaborationApi {
  enabled: boolean;
  canEdit: () => boolean;
  start: (displayName: string, color: string, mode: CollaborationMode) => Promise<string>;
  join: (sessionId: string, displayName: string, color: string) => Promise<void>;
  leave: () => void;
  setMode: (mode: CollaborationMode) => void;
  setParticipantMode: (clientId: string, canEdit: boolean) => void;
  setFollowHost: (enabled: boolean) => void;
  sendChat: (text: string, coordinate?: { lng: number; lat: number } | null) => boolean;
  sendCommentMutation: (action: CommentMutationAction) => boolean;
}

export function useCollaboration(
  mapControllerRef: RefObject<MapController | null>,
): CollaborationApi {
  const baseUrl = useMemo(() => resolveCollabBaseUrl(), []);
  const enabled = baseUrl !== null;

  const connRef = useRef<CollabConnection | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);
  const lastContentRef = useRef<string | null>(null);
  const revRef = useRef(0);
  const snapshotRequestRef = useRef(0);
  const selfIdRef = useRef<string | null>(null);
  const syncPausedRef = useRef(false);
  const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingConnectRef = useRef<{
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);

  useEffect(
    () => () => {
      disconnect();
      useAppStore.getState().resetCollaboration();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const canEdit = (): boolean => {
    const c = useAppStore.getState().collaboration;
    if (!c.isActive) return false;
    if (c.role === "host") return true;
    const self = c.participants.find((p) => p.clientId === c.clientId);
    return self?.editOverride ?? c.mode === "co-edit";
  };

  const sendSnapshot = async (): Promise<void> => {
    if (!canEdit() || syncPausedRef.current) return;
    const request = ++snapshotRequestRef.current;
    let project: GeoLibreProject;
    try {
      project = await buildCollaborationSnapshot(mapControllerRef);
    } catch {
      // Materializing control-managed vector data can fail (the plugin chunk
      // or a DuckDB query). Surface it so the participant knows their edits
      // stopped propagating, but only for the newest request that is still
      // allowed to broadcast: a stale failure, or one racing a relay error
      // that already paused sync, must not overwrite the message the user
      // needs to see.
      if (request === snapshotRequestRef.current && canEdit() && !syncPausedRef.current) {
        useAppStore.getState().setCollaboration({ error: i18n.t("collaborate.shareFailed") });
      }
      return;
    }
    // Materializing control-managed vector data is asynchronous. Discard an
    // older result if a newer broadcast started while it was being read.
    if (request !== snapshotRequestRef.current || !canEdit() || syncPausedRef.current) return;
    const content = serializeProject(project);
    if (content === lastContentRef.current) return;
    lastContentRef.current = content;
    revRef.current += 1;
    connRef.current?.send({ type: "snapshot", project, rev: revRef.current });
  };

  const scheduleRestore = (): void => {
    if (restoreTimerRef.current) clearTimeout(restoreTimerRef.current);
    restoreTimerRef.current = setTimeout(() => {
      restoreTimerRef.current = null;
      useAppStore.setState((s) => ({ projectGeneration: s.projectGeneration + 1 }));
    }, 200);
  };

  const applyRemoteSnapshot = (project: GeoLibreProject, initial: boolean): void => {
    const state = useAppStore.getState();
    const localView = mapControllerRef.current?.readView() ?? state.mapView;
    const merged = mergeInboundCollaborationProject(project, localView, state.projectPlugins);
    if (initial) {
      useAppStore
        .getState()
        .loadProject(merged, null, { rememberRecent: false, presenting: false });
    } else {
      const applied = applyProjectToStore(merged);
      useAppStore.setState({ ...applied });
      clearHistory();
      scheduleRestore();
    }
    lastContentRef.current = serializeProject(buildProjectEgressSnapshot(mapControllerRef));
  };

  const handleMessage = (message: ServerMessage): void => {
    const store = useAppStore.getState();
    switch (message.type) {
      case "welcome": {
        selfIdRef.current = message.clientId;
        store.setCollaboration({
          isActive: true,
          connecting: false,
          clientId: message.clientId,
          role: message.role,
          mode: message.mode,
          participants: message.participants,
          chat: message.chat ?? [],
          error: null,
        });
        for (const [clientId, entry] of Object.entries(message.presence)) {
          if (clientId === message.clientId) continue;
          const participant = message.participants.find((p) => p.clientId === clientId);
          store.updateCollaborationPresence(clientId, {
            displayName: participant?.displayName ?? i18n.t("collaborate.guest"),
            color: participant?.color ?? "#888888",
            cursor: entry.cursor,
            view: entry.view,
          });
        }
        if (message.snapshot) {
          applyRemoteSnapshot(message.snapshot, true);
        } else if (message.role === "host") {
          // A newly created session has no relay snapshot yet. The store
          // subscription only observes changes made after attach(), so without
          // this seed a project (especially external-plugin layers loaded
          // before starting collaboration) stays invisible to the first guest
          // until the host happens to edit something.
          void sendSnapshot();
        }
        // Guests follow the host by default. Apply the host's latest presence
        // immediately instead of waiting for their next moveend event.
        if (message.role === "guest" && useAppStore.getState().collaboration.followHost) {
          const host = message.participants.find((participant) => participant.role === "host");
          const hostView = host ? message.presence[host.clientId]?.view : null;
          if (hostView) mapControllerRef.current?.applyView(hostView);
        }
        const pending = pendingConnectRef.current;
        pendingConnectRef.current = null;
        pending?.resolve();
        break;
      }
      case "snapshot":
        // origin is the server-assigned clientId of the sender; skip our own echo.
        if (message.origin !== selfIdRef.current) {
          applyRemoteSnapshot(message.project, false);
        }
        break;
      case "presence": {
        if (message.clientId === selfIdRef.current) break;
        const collab = useAppStore.getState().collaboration;
        const participant = collab.participants.find((p) => p.clientId === message.clientId);
        const presence: CollaborationPresence = {
          displayName: participant?.displayName ?? i18n.t("collaborate.guest"),
          color: participant?.color ?? "#888888",
          cursor: message.cursor,
          view: message.view,
        };
        store.updateCollaborationPresence(message.clientId, presence);
        if (collab.followHost && participant?.role === "host" && message.view) {
          mapControllerRef.current?.applyView(message.view);
        }
        break;
      }
      case "participants": {
        store.setCollaboration({ participants: message.participants });
        const present = new Set(message.participants.map((p) => p.clientId));
        const presence = useAppStore.getState().collaboration.presence;
        for (const id of Object.keys(presence)) {
          if (!present.has(id)) store.updateCollaborationPresence(id, null);
        }
        break;
      }
      case "mode":
        store.setCollaboration({ mode: message.mode });
        break;
      case "chat":
        // The relay echoes our own messages back with the server-assigned id.
        // Always add via the echo so the server id is used — addCollaborationChat
        // deduplicates by id so subsequent echoes are harmless.
        store.addCollaborationChat(message.message);
        break;
      case "comment-mutation": {
        // The relay excludes the sender (broadcast(msg, ws)), so we never receive
        // our own mutations back over WebSocket. Apply everything we receive.
        const action = message.action;
        if (action.type === "add") {
          store.addComment(action.comment);
        } else if (action.type === "reply") {
          store.replyToComment(action.commentId, action.reply);
        } else if (action.type === "toggle-resolve") {
          store.toggleResolveComment(action.commentId, action.resolved);
        } else if (action.type === "delete") {
          store.deleteComment(action.commentId);
        }
        break;
      }
      case "error":
        store.setCollaboration({ error: message.message });
        if (message.code === "too-large") syncPausedRef.current = true;
        break;
    }
  };

  // Called from onOpen — the socket is open and we are ready to join.
  const attach = (displayName: string, color: string, hostToken: string | undefined): void => {
    const conn = connRef.current;
    if (!conn) return;

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const scheduleSnapshot = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void sendSnapshot();
      }, SNAPSHOT_DEBOUNCE_MS);
    };

    const unsubscribe = useAppStore.subscribe((state, prev) => {
      if (projectChanged(state, prev)) scheduleSnapshot();
    });

    const map = mapControllerRef.current?.getMap() ?? null;
    const detachMap = map ? bindPresence(map, conn) : () => {};

    conn.send({
      type: "join",
      clientId: selfIdRef.current ?? crypto.randomUUID(),
      displayName,
      color,
      hostToken,
    });

    teardownRef.current = () => {
      if (debounce) clearTimeout(debounce);
      unsubscribe();
      detachMap();
    };
  };

  const bindPresence = (map: MapLibreMap, conn: CollabConnection): (() => void) => {
    let lastCursor = 0;
    const onMouseMove = (e: { lngLat: { lng: number; lat: number } }) => {
      const now = Date.now();
      if (now - lastCursor < CURSOR_THROTTLE_MS) return;
      lastCursor = now;
      conn.send({ type: "presence", cursor: { lng: e.lngLat.lng, lat: e.lngLat.lat } });
    };
    const onMouseOut = () => conn.send({ type: "presence", cursor: null });
    const onMoveEnd = (event?: { flightCameraToken?: number }) => {
      if (event?.flightCameraToken !== undefined) return;
      conn.send({ type: "presence", view: mapControllerRef.current?.readView() ?? null });
    };
    map.on("mousemove", onMouseMove);
    map.on("mouseout", onMouseOut);
    map.on("moveend", onMoveEnd);
    onMoveEnd();
    return () => {
      map.off("mousemove", onMouseMove);
      map.off("mouseout", onMouseOut);
      map.off("moveend", onMoveEnd);
    };
  };

  const connect = (
    sessionId: string,
    displayName: string,
    color: string,
    hostToken: string | undefined,
  ): Promise<void> => {
    disconnect();
    syncPausedRef.current = false;
    selfIdRef.current = crypto.randomUUID();
    lastContentRef.current = null;
    revRef.current = 0;

    const normalizedCode = sessionId.trim().toUpperCase();

    const selfParticipant: CollaborationParticipant = {
      clientId: selfIdRef.current,
      displayName,
      color,
      role: hostToken ? "host" : "guest",
      editOverride: null,
    };

    useAppStore.getState().setCollaboration({
      connecting: true,
      isActive: false,
      sessionId: normalizedCode,
      selfName: displayName,
      selfColor: color,
      role: hostToken ? "host" : "guest",
      mode: "co-edit",
      clientId: selfIdRef.current,
      participants: [selfParticipant],
      // A participant joining an existing session normally wants to arrive at
      // and stay with the host's viewport. They can turn this off at any time.
      followHost: !hostToken,
      error: null,
    });

    return new Promise<void>((resolve, reject) => {
      pendingConnectRef.current = { resolve, reject };

      const conn = new CollabConnection(sessionWsUrl(baseUrl!, normalizedCode), {
        onOpen: () => {
          if (connRef.current !== conn) return;
          attach(displayName, color, hostToken);
        },
        onMessage: (msg) => {
          if (connRef.current !== conn) return;
          handleMessage(msg);
        },
        onClose: (reconnecting) => {
          if (connRef.current && connRef.current !== conn) return;
          teardownRef.current?.();
          teardownRef.current = null;
          if (reconnecting && pendingConnectRef.current) {
            const p = pendingConnectRef.current;
            pendingConnectRef.current = null;
            conn.close();
            useAppStore
              .getState()
              .setCollaboration({ connecting: false, error: "Could not connect to the session." });
            p.reject(new Error("Could not connect to the session."));
          }
        },
      });
      connRef.current = conn;
      conn.connect();
    });
  };

  const disconnect = (): void => {
    snapshotRequestRef.current += 1;
    teardownRef.current?.();
    teardownRef.current = null;
    if (pendingConnectRef.current) {
      const p = pendingConnectRef.current;
      pendingConnectRef.current = null;
      p.reject(new Error(i18n.t("comments.sessionDisconnected")));
    }
    connRef.current?.close();
    connRef.current = null;
    selfIdRef.current = null;
    if (restoreTimerRef.current) {
      clearTimeout(restoreTimerRef.current);
      restoreTimerRef.current = null;
    }
  };

  const start = useCallback(
    async (displayName: string, color: string, mode: CollaborationMode) => {
      const session = await createSession(mode, baseUrl);
      await connect(session.sessionId, displayName, color, session.hostToken);
      return session.sessionId;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseUrl],
  );

  const join = useCallback(
    async (sessionId: string, displayName: string, color: string) => {
      await connect(sessionId.trim().toUpperCase(), displayName, color, undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseUrl],
  );

  const leave = useCallback(() => {
    disconnect();
    useAppStore.getState().resetCollaboration();
  }, []);

  const setMode = useCallback((mode: CollaborationMode) => {
    connRef.current?.send({ type: "set-mode", mode });
  }, []);

  const setParticipantMode = useCallback((clientId: string, canEditFlag: boolean) => {
    connRef.current?.send({ type: "set-participant-mode", clientId, canEdit: canEditFlag });
  }, []);

  const sendChat = useCallback((text: string, coordinate?: { lng: number; lat: number } | null) => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    // Send to the relay only. The relay broadcasts back to everyone including
    // the sender with a server-assigned id; handleMessage("chat") adds it to
    // the store then. This means the server's ordering is always the truth and
    // the sender's message appears only once (via the echo, not optimistically).
    return connRef.current?.send({ type: "chat", text: trimmed, coordinate }) ?? false;
  }, []);

  const sendCommentMutation = useCallback((action: CommentMutationAction) => {
    return connRef.current?.send({ type: "comment-mutation", action }) ?? false;
  }, []);

  const setFollowHost = useCallback((enabled: boolean) => {
    const store = useAppStore.getState();
    store.setCollaboration({ followHost: enabled });
    if (!enabled) return;
    const host = store.collaboration.participants.find((p) => p.role === "host");
    const view = host ? store.collaboration.presence[host.clientId]?.view : null;
    if (view) mapControllerRef.current?.applyView(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    enabled,
    canEdit,
    start,
    join,
    leave,
    setMode,
    setParticipantMode,
    setFollowHost,
    sendChat,
    sendCommentMutation,
  };
}
