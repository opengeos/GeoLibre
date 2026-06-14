import {
  serializeProject,
  useAppStore,
  type CollaborationMode,
  type CollaborationPresence,
  type GeoLibreProject,
} from "@geolibre/core";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";
import type { MapController } from "@geolibre/map";
import type { Map as MapLibreMap } from "maplibre-gl";
import i18n from "../i18n";
import { buildProjectSnapshot } from "../lib/build-project-snapshot";
import {
  CollabConnection,
  createSession,
  resolveCollabBaseUrl,
  sessionWsUrl,
} from "../lib/collab-client";
import type { ServerMessage } from "../lib/collab-protocol";

// Coalesce the burst of store writes one user action produces into a single
// outbound snapshot — same window the embed bridge uses.
const SNAPSHOT_DEBOUNCE_MS = 250;
// Cursor presence is high-frequency; cap it so we don't flood the relay.
const CURSOR_THROTTLE_MS = 40;

export interface CollaborationApi {
  /** True when `VITE_GEOLIBRE_COLLAB_URL` is configured; gates all UI. */
  enabled: boolean;
  /** Host a new session and connect. Resolves with the shareable code. */
  start: (
    displayName: string,
    color: string,
    mode: CollaborationMode,
  ) => Promise<string>;
  /** Join an existing session by its code. */
  join: (sessionId: string, displayName: string, color: string) => Promise<void>;
  /** Leave the active session and tear everything down. */
  leave: () => void;
  /** Host-only: switch the session between view-only and co-edit. */
  setMode: (mode: CollaborationMode) => void;
}

/**
 * Drives live multi-user collaboration (issue #307): subscribes to the store and
 * broadcasts debounced, deduped project snapshots over a WebSocket, streams
 * cursor/viewport presence, and applies inbound snapshots/presence back into the
 * store. Inert when collaboration is not configured.
 *
 * The transport mirrors {@link useEmbedBridge}: a single `lastAppliedContent`
 * cache suppresses the echo a remote apply would otherwise re-broadcast.
 *
 * @param mapControllerRef - Ref to the live map controller, used to read the
 *   camera for snapshots and to bind cursor/viewport presence handlers.
 * @returns The session control API consumed by the Collaborate dialog.
 */
export function useCollaboration(
  mapControllerRef: RefObject<MapController | null>,
): CollaborationApi {
  const baseUrl = useMemo(() => resolveCollabBaseUrl(), []);
  const enabled = baseUrl !== null;

  // All mutable session machinery lives in refs so the effects/actions are
  // stable and don't re-subscribe on every render.
  const connRef = useRef<CollabConnection | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);
  // Shared dedupe key for both directions: the last serialized project we sent
  // or applied. A remote apply sets this first so the store update it triggers
  // serializes identically and is suppressed (no echo).
  const lastContentRef = useRef<string | null>(null);
  const revRef = useRef(0);
  const selfIdRef = useRef<string | null>(null);
  // Whether we ever completed the initial join (received a `welcome`). A
  // disconnect before that means the session code was bad or the relay is
  // unreachable, which we treat as a fatal connect failure rather than retrying
  // a dead session forever.
  const joinedRef = useRef(false);

  // Tear everything down on unmount: close the socket AND clear the slice so a
  // stale "active" session can't linger in the store if the host unmounts.
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
    return c.role === "host" || c.mode === "co-edit";
  };

  const sendSnapshot = (): void => {
    const conn = connRef.current;
    if (!conn || !canEdit()) return;
    const project = buildProjectSnapshot(mapControllerRef);
    const content = serializeProject(project);
    // Skip identical snapshots (selection/presence writes don't change content).
    if (content === lastContentRef.current) return;
    lastContentRef.current = content;
    revRef.current += 1;
    conn.send({ type: "snapshot", project, rev: revRef.current });
  };

  const applyRemoteSnapshot = (project: GeoLibreProject): void => {
    // Keep each participant's own camera: replace the incoming view with the
    // local one before applying, so a peer's edit never yanks our viewport.
    // Where others are looking is conveyed by presence viewport rectangles.
    const localView =
      mapControllerRef.current?.readView() ?? useAppStore.getState().mapView;
    const merged: GeoLibreProject = { ...project, mapView: localView };
    // Set the dedupe key to the post-merge string BEFORE applying: loadProject
    // triggers the store subscription, which re-serializes to this same string
    // and is suppressed, so the remote apply is never re-broadcast.
    lastContentRef.current = serializeProject(merged);
    useAppStore
      .getState()
      .loadProject(merged, null, { rememberRecent: false, presenting: false });
  };

  const handleMessage = (message: ServerMessage): void => {
    const store = useAppStore.getState();
    switch (message.type) {
      case "welcome": {
        joinedRef.current = true;
        selfIdRef.current = message.clientId;
        store.setCollaboration({
          isActive: true,
          connecting: false,
          clientId: message.clientId,
          role: message.role,
          mode: message.mode,
          participants: message.participants,
          error: null,
        });
        if (message.snapshot) applyRemoteSnapshot(message.snapshot);
        break;
      }
      case "snapshot":
        if (message.origin !== selfIdRef.current) {
          applyRemoteSnapshot(message.project);
        }
        break;
      case "presence": {
        if (message.clientId === selfIdRef.current) break;
        const participant = useAppStore
          .getState()
          .collaboration.participants.find(
            (p) => p.clientId === message.clientId,
          );
        const presence: CollaborationPresence = {
          displayName: participant?.displayName ?? i18n.t("collaborate.guest"),
          color: participant?.color ?? "#888888",
          cursor: message.cursor,
          view: message.view,
        };
        store.updateCollaborationPresence(message.clientId, presence);
        break;
      }
      case "participants": {
        store.setCollaboration({ participants: message.participants });
        // Drop presence for anyone who left so stale cursors don't linger.
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
      case "error":
        store.setCollaboration({ error: message.message });
        break;
    }
  };

  // Wire the store subscription and map presence handlers once a connection is
  // open. Returns a teardown that removes them all.
  const attach = (
    displayName: string,
    color: string,
    hostToken: string | undefined,
  ): void => {
    const conn = connRef.current;
    if (!conn) return;

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const scheduleSnapshot = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        sendSnapshot();
      }, SNAPSHOT_DEBOUNCE_MS);
    };

    // Only schedule when the project content could have changed; presence and
    // collaboration-slice writes (remote cursors) must not keep resetting the
    // debounce and starving our own edits.
    const unsubscribe = useAppStore.subscribe((state, prev) => {
      if (projectChanged(state, prev)) scheduleSnapshot();
    });

    const map = mapControllerRef.current?.getMap() ?? null;
    const detachMap = map ? bindPresence(map, conn) : () => {};

    // Send join once the socket is open (attach runs from onOpen).
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
      conn.send({
        type: "presence",
        cursor: { lng: e.lngLat.lng, lat: e.lngLat.lat },
      });
    };
    const onMouseOut = () => conn.send({ type: "presence", cursor: null });
    const onMoveEnd = () =>
      conn.send({
        type: "presence",
        view: mapControllerRef.current?.readView() ?? null,
      });
    map.on("mousemove", onMouseMove);
    map.on("mouseout", onMouseOut);
    map.on("moveend", onMoveEnd);
    // Announce our initial viewport immediately.
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
  ): void => {
    disconnect();
    joinedRef.current = false;
    selfIdRef.current = crypto.randomUUID();
    lastContentRef.current = null;
    revRef.current = 0;
    useAppStore.getState().setCollaboration({
      connecting: true,
      sessionId,
      selfName: displayName,
      selfColor: color,
      error: null,
    });
    const conn = new CollabConnection(sessionWsUrl(baseUrl!, sessionId), {
      onOpen: () => attach(displayName, color, hostToken),
      onMessage: handleMessage,
      onClose: (reconnecting) => {
        // A reconnect re-runs onOpen -> attach -> join, so drop the stale
        // store subscription/handlers first.
        teardownRef.current?.();
        teardownRef.current = null;
        // A disconnect before the first successful join (bad session code,
        // unreachable relay) is fatal: stop retrying and surface the error to
        // the dialog instead of spinning forever. close() here suppresses the
        // pending reconnect (see CollabConnection).
        if (reconnecting && !joinedRef.current) {
          disconnect();
          useAppStore.getState().setCollaboration({
            connecting: false,
            isActive: false,
            error: i18n.t("collaborate.connectFailed"),
          });
          return;
        }
        useAppStore.getState().setCollaboration({ connecting: reconnecting });
      },
    });
    connRef.current = conn;
    conn.connect();
  };

  const disconnect = (): void => {
    teardownRef.current?.();
    teardownRef.current = null;
    connRef.current?.close();
    connRef.current = null;
    selfIdRef.current = null;
  };

  // `connect`/`disconnect` close only over stable refs and `baseUrl`, so keying
  // these actions on `baseUrl` alone is correct; listing `connect` would
  // needlessly re-create them every render.
  const start = useCallback(
    async (displayName: string, color: string, mode: CollaborationMode) => {
      const session = await createSession(mode, baseUrl);
      connect(session.sessionId, displayName, color, session.hostToken);
      return session.sessionId;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseUrl],
  );

  const join = useCallback(
    async (sessionId: string, displayName: string, color: string) => {
      connect(sessionId.trim().toUpperCase(), displayName, color, undefined);
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

  return { enabled, start, join, leave, setMode };
}

// Reference-compares the store fields that feed a project snapshot. Every
// mutating store action produces new refs for the slice it touches, so this is
// a cheap, correct "did the broadcastable project change?" check that ignores
// selection, UI, and collaboration-slice churn.
function projectChanged(
  a: ReturnType<typeof useAppStore.getState>,
  b: ReturnType<typeof useAppStore.getState>,
): boolean {
  return (
    a.projectName !== b.projectName ||
    a.mapView !== b.mapView ||
    a.basemapStyleUrl !== b.basemapStyleUrl ||
    a.basemapVisible !== b.basemapVisible ||
    a.basemapOpacity !== b.basemapOpacity ||
    a.layers !== b.layers ||
    a.layerGroups !== b.layerGroups ||
    a.preferences !== b.preferences ||
    a.projectPlugins !== b.projectPlugins ||
    a.legend !== b.legend ||
    a.storymap !== b.storymap ||
    a.metadata !== b.metadata
  );
}
