import {
  applyProjectToStore,
  clearHistory,
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
  /** Toggle whether this participant's camera follows the host's viewport. */
  setFollowHost: (enabled: boolean) => void;
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
  // Set when the relay rejects a snapshot as too large; stops further sends so
  // an over-size project doesn't re-fail on every keystroke. Reset on reconnect.
  const syncPausedRef = useRef(false);
  // Debounces the projectGeneration bump that drives plugin-layer restoration
  // after a burst of incremental remote edits.
  const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Settles when the current connect attempt joins (welcome) or fatally fails,
  // so start()/join() resolve only on real success and the dialog keeps its
  // busy spinner until then.
  const pendingConnectRef = useRef<{
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);

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
    // Require an active (joined) session so a debounced snapshot can't fire in
    // the window between connect() and the `welcome` (where mode still holds its
    // default of "co-edit").
    return c.isActive && (c.role === "host" || c.mode === "co-edit");
  };

  const sendSnapshot = (): void => {
    const conn = connRef.current;
    if (!conn || !canEdit() || syncPausedRef.current) return;
    const project = buildProjectSnapshot(mapControllerRef);
    const content = serializeProject(project);
    // Skip identical snapshots (selection/presence writes don't change content).
    if (content === lastContentRef.current) return;
    lastContentRef.current = content;
    revRef.current += 1;
    conn.send({ type: "snapshot", project, rev: revRef.current });
  };

  // Bump projectGeneration (debounced) to run DesktopShell's plugin/native-layer
  // restoration once after a burst of incremental edits settles. The bump alone
  // re-runs the restoration effect; it changes no serialized project field, so
  // the snapshot subscription dedupes it (no echo).
  const RESTORE_DEBOUNCE_MS = 200;
  const scheduleRestore = (): void => {
    if (restoreTimerRef.current) clearTimeout(restoreTimerRef.current);
    restoreTimerRef.current = setTimeout(() => {
      restoreTimerRef.current = null;
      useAppStore.setState((s) => ({
        projectGeneration: s.projectGeneration + 1,
      }));
    }, RESTORE_DEBOUNCE_MS);
  };

  const applyRemoteSnapshot = (
    project: GeoLibreProject,
    initial: boolean,
  ): void => {
    // Keep each participant's own camera: replace the incoming view with the
    // local one before applying, so a peer's edit never yanks our viewport.
    // Where others are looking is conveyed by presence viewport rectangles.
    const localView =
      mapControllerRef.current?.readView() ?? useAppStore.getState().mapView;
    const merged: GeoLibreProject = { ...project, mapView: localView };
    if (initial) {
      // First bootstrap (the welcome snapshot): a one-time full loadProject is
      // fine and runs the plugin/native-layer restoration so the joiner sees
      // the host's existing 3D-tiles/deck/raster layers.
      useAppStore
        .getState()
        .loadProject(merged, null, { rememberRecent: false, presenting: false });
    } else {
      // Incremental remote edit: apply the project slice immediately so
      // MapLibre-native layers (geojson, vector/raster tiles, …) reconcile via
      // MapCanvas's syncLayers without flicker. We apply directly rather than
      // via loadProject so the local user's selectedLayerId isn't reset to the
      // first layer on every remote edit.
      const applied = applyProjectToStore(merged);
      useAppStore.setState({ ...applied });
      clearHistory();
      // Plugin-rendered layer types (raster-COG, LiDAR, 3D-tiles, deck) are NOT
      // handled by syncLayers — DesktopShell's restoration effect (keyed on
      // projectGeneration) renders them. Bump it, debounced, so a burst of edits
      // triggers that heavier restoration once after it settles rather than on
      // every snapshot.
      scheduleRestore();
    }
    // Cache the POST-normalization serialization (mirrors useEmbedBridge): the
    // store update we just made re-serializes to this exact string and is
    // suppressed, so a remote apply never echoes back as a new snapshot.
    // Serializing `merged` (the pre-normalization input) instead would mismatch
    // applyProjectToStore's normalized output (deduped styles, defaults,
    // reordering) and create a broadcast feedback loop.
    lastContentRef.current = serializeProject(
      buildProjectSnapshot(mapControllerRef),
    );
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
        // Bootstrap existing participants' cursors/viewports so they're visible
        // immediately, not only after their next move.
        for (const [clientId, entry] of Object.entries(message.presence)) {
          if (clientId === message.clientId) continue;
          const participant = message.participants.find(
            (p) => p.clientId === clientId,
          );
          store.updateCollaborationPresence(clientId, {
            displayName: participant?.displayName ?? i18n.t("collaborate.guest"),
            color: participant?.color ?? "#888888",
            cursor: entry.cursor,
            view: entry.view,
          });
        }
        if (message.snapshot) applyRemoteSnapshot(message.snapshot, true);
        // Resolve the connect() promise so start()/join() (and the dialog's busy
        // state) settle only once the join actually succeeds.
        const pending = pendingConnectRef.current;
        pendingConnectRef.current = null;
        pending?.resolve();
        break;
      }
      case "snapshot":
        if (message.origin !== selfIdRef.current) {
          applyRemoteSnapshot(message.project, false);
        }
        break;
      case "presence": {
        if (message.clientId === selfIdRef.current) break;
        const collab = useAppStore.getState().collaboration;
        const participant = collab.participants.find(
          (p) => p.clientId === message.clientId,
        );
        const presence: CollaborationPresence = {
          displayName: participant?.displayName ?? i18n.t("collaborate.guest"),
          color: participant?.color ?? "#888888",
          cursor: message.cursor,
          view: message.view,
        };
        store.updateCollaborationPresence(message.clientId, presence);
        // Follow mode: mirror the host's camera onto the local map.
        if (
          collab.followHost &&
          participant?.role === "host" &&
          message.view
        ) {
          mapControllerRef.current?.applyView(message.view);
        }
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
        // A too-large project will fail on every subsequent edit; pause sending
        // so it doesn't re-fail in a loop until the session is rejoined.
        if (message.code === "too-large") syncPausedRef.current = true;
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

  // Resolves once the connection joins (welcome) and rejects on a fatal
  // connect failure, so callers can keep a busy state until the join really
  // succeeds.
  const connect = (
    sessionId: string,
    displayName: string,
    color: string,
    hostToken: string | undefined,
  ): Promise<void> => {
    // Unreachable when disabled (the UI is hidden), but guard so `baseUrl` is
    // a string below without a non-null assertion.
    if (!baseUrl) return Promise.reject(new Error("not configured"));
    disconnect();
    joinedRef.current = false;
    syncPausedRef.current = false;
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
    return new Promise<void>((resolve, reject) => {
      pendingConnectRef.current = { resolve, reject };
      const conn = new CollabConnection(sessionWsUrl(baseUrl, sessionId), {
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
            const pending = pendingConnectRef.current;
            pendingConnectRef.current = null;
            disconnect();
            useAppStore.getState().setCollaboration({
              connecting: false,
              isActive: false,
              error: i18n.t("collaborate.connectFailed"),
            });
            pending?.reject(new Error("connect failed"));
            return;
          }
          useAppStore.getState().setCollaboration({ connecting: reconnecting });
        },
      });
      connRef.current = conn;
      conn.connect();
    });
  };

  const disconnect = (): void => {
    teardownRef.current?.();
    teardownRef.current = null;
    connRef.current?.close();
    connRef.current = null;
    selfIdRef.current = null;
    if (restoreTimerRef.current) {
      clearTimeout(restoreTimerRef.current);
      restoreTimerRef.current = null;
    }
    // Drop any in-flight connect promise without settling it; a fresh connect()
    // installs a new one, and the only fatal path settles it explicitly above.
    pendingConnectRef.current = null;
  };

  // `connect`/`disconnect` close only over stable refs and `baseUrl`, so keying
  // these actions on `baseUrl` alone is correct; listing `connect` would
  // needlessly re-create them every render.
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

  const setFollowHost = useCallback((enabled: boolean) => {
    const store = useAppStore.getState();
    store.setCollaboration({ followHost: enabled });
    if (!enabled) return;
    // Jump to the host's last-known viewport immediately so following takes
    // effect now rather than only on the host's next move.
    const host = store.collaboration.participants.find(
      (p) => p.role === "host",
    );
    const view = host
      ? store.collaboration.presence[host.clientId]?.view
      : null;
    if (view) mapControllerRef.current?.applyView(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { enabled, start, join, leave, setMode, setFollowHost };
}

// Reference-compares the store fields that feed a project snapshot. Every
// mutating store action produces new refs for the slice it touches, so this is
// a cheap, correct "did the broadcastable project change?" check that ignores
// selection, UI, and collaboration-slice churn.
//
// `mapView` is deliberately NOT compared: each participant keeps their own
// camera (applyRemoteSnapshot overrides the incoming view), so broadcasting a
// full-project snapshot on every pan/zoom only churns receivers' layer
// reconciliation for no visible effect — and that churn was intermittently
// crashing the map under rapid panning. Camera is shared through presence
// (viewport rectangles + opt-in follow-host) instead.
function projectChanged(
  a: ReturnType<typeof useAppStore.getState>,
  b: ReturnType<typeof useAppStore.getState>,
): boolean {
  return (
    a.projectName !== b.projectName ||
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
