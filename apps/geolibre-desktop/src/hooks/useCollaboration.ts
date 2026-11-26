import {
  applyProjectToStore,
  assertImportedDocumentCopiesAvailable,
  clearHistory,
  DEFAULT_BASEMAP,
  gateRegionalBasemap,
  rebaseImportedDocumentLayer,
  serializeProject,
  useAppStore,
  type CollaborationMode,
  type CollaborationParticipant,
  type CollaborationPresence,
  type GeoLibreProject,
} from "@geolibre/core";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";
import type { MapEngine } from "@geolibre/map";
import i18n from "../i18n";
import {
  buildCollaborationSnapshot,
  buildProjectEgressSnapshot,
} from "../lib/build-project-snapshot";
import { createBasemapEgressTracker } from "../lib/basemap-egress";
import { notify } from "../lib/notify";
import { projectChanged } from "../lib/project-broadcast-changed";
import {
  CollabConnection,
  createSession,
  resolveCollabBaseUrl,
  sessionWsUrl,
} from "../lib/collab-client";
import {
  type CommentMutationAction,
  type ServerMessage,
  participantCanEditLayer,
} from "../lib/collab-protocol";
import { mergeInboundCollaborationProject } from "../lib/collaboration-project";
import { createViewOnlyNotice, notifyLayerLockedRejection } from "../lib/collab-local-edits";

const SNAPSHOT_DEBOUNCE_MS = 250;
const CURSOR_THROTTLE_MS = 40;

export interface CollaborationApi {
  enabled: boolean;
  canEdit: () => boolean;
  canEditLayer: (layerId: string) => boolean;
  start: (
    displayName: string,
    color: string,
    mode: CollaborationMode,
    requireIdentity?: boolean,
  ) => Promise<string>;
  join: (
    sessionId: string,
    displayName: string,
    color: string,
    options?: { inviteToken?: string; identityToken?: string },
  ) => Promise<void>;
  leave: () => void;
  setMode: (mode: CollaborationMode) => void;
  setParticipantMode: (clientId: string, canEdit: boolean) => void;
  mintInvite: (role: CollaborationMode, maxUses?: number) => void;
  revokeInvite: (token: string) => void;
  setSessionConfig: (config: { requireIdentity?: boolean }) => void;
  setLayerLocks: (lockedLayerIds: string[]) => void;
  kickParticipant: (clientId: string, reason?: string) => void;
  blockParticipant: (clientId: string, reason?: string) => void;
  setFollowHost: (enabled: boolean) => void;
  sendChat: (text: string, coordinate?: { lng: number; lat: number } | null) => boolean;
  sendCommentMutation: (action: CommentMutationAction) => boolean;
}

export function useCollaboration(
  mapControllerRef: RefObject<MapEngine | null>,
  mapReadyGeneration: number,
): CollaborationApi {
  const baseUrl = useMemo(() => resolveCollabBaseUrl(), []);
  const enabled = baseUrl !== null;

  const connRef = useRef<CollabConnection | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);
  const presenceTeardownRef = useRef<(() => void) | null>(null);
  const lastContentRef = useRef<string | null>(null);
  // Carries a session regional basemap this deployment blocks back out
  // unchanged, so this client's edits do not reset it for every other peer.
  const basemapEgressRef = useRef(createBasemapEgressTracker());
  const revRef = useRef(0);
  const snapshotRequestRef = useRef(0);
  const selfIdRef = useRef<string | null>(null);
  const syncPausedRef = useRef(false);
  // Set while a peer's snapshot is written, so it is not taken for a local edit.
  const applyingRemoteRef = useRef(false);
  const viewOnlyNoticeRef = useRef(createViewOnlyNotice());
  const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const joinGenerationRef = useRef(0);
  // The join can wait on the identity lookup; frames sent before it would be
  // refused by the relay, so project pushes hold until it is out.
  const joinSentRef = useRef(false);
  // Set after an anonymous join by a possibly signed-in user: retries once
  // with a fresh identity token if the relay answers identity-required.
  const identityRetryRef = useRef<(() => Promise<boolean>) | null>(null);
  // Set once this connection's welcome has been handled: a whole-project push
  // before it could overwrite the session with a project that has not yet
  // taken in the relay's state.
  const welcomedRef = useRef(false);
  const pendingConnectRef = useRef<{
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);
  const collaborationActive = useAppStore((state) => state.collaboration.isActive);
  const primaryRenderer = useAppStore((state) => state.primaryRenderer);

  useEffect(
    () => () => {
      disconnect();
      useAppStore.getState().resetCollaboration();
    },
    [],
  );

  // A welcome snapshot can swap the renderer after the socket connects. Bind
  // presence after that commit, and rebind whenever a live session changes
  // engines, instead of holding listeners on the destroyed initial canvas.
  useEffect(() => {
    if (!collaborationActive) {
      presenceTeardownRef.current?.();
      presenceTeardownRef.current = null;
      return;
    }
    const frame = requestAnimationFrame(() => {
      presenceTeardownRef.current?.();
      const engine = mapControllerRef.current;
      const conn = connRef.current;
      presenceTeardownRef.current = engine && conn ? bindPresence(engine, conn) : null;
    });
    return () => {
      cancelAnimationFrame(frame);
      presenceTeardownRef.current?.();
      presenceTeardownRef.current = null;
    };
    // bindPresence is deliberately local to this hook; renderer/session state
    // is the lifecycle boundary for its DOM and camera listeners.
  }, [collaborationActive, primaryRenderer, mapReadyGeneration, mapControllerRef]);

  const canEdit = (): boolean => {
    const c = useAppStore.getState().collaboration;
    if (!c.isActive) return false;
    if (c.role === "host") return true;
    const self = c.participants.find((p) => p.clientId === c.clientId);
    return self?.editOverride ?? c.mode === "co-edit";
  };

  const canEditLayer = useCallback((layerId: string): boolean => {
    const c = useAppStore.getState().collaboration;
    if (!c.isActive) return true;
    if (c.role === "host") return true;
    const self = c.participants.find((p) => p.clientId === c.clientId);
    if (!self) {
      return c.mode === "co-edit" && !(c.lockedLayerIds ?? []).includes(layerId);
    }
    return participantCanEditLayer(self, c.mode, layerId, c.lockedLayerIds ?? []);
  }, []);

  const sendSnapshot = async (): Promise<void> => {
    // The welcome either loads the session's project or, for a host of an
    // empty session, sends this one; an edit before it is covered by that.
    if (!welcomedRef.current) return;
    if (!canEdit() || syncPausedRef.current) return;
    const request = ++snapshotRequestRef.current;
    let project: GeoLibreProject;
    try {
      project = await buildCollaborationSnapshot(mapControllerRef);
    } catch {
      if (request === snapshotRequestRef.current && canEdit() && !syncPausedRef.current) {
        useAppStore.getState().setCollaboration({ error: i18n.t("collaborate.shareFailed") });
      }
      return;
    }
    if (request !== snapshotRequestRef.current || !canEdit() || syncPausedRef.current) return;
    project = basemapEgressRef.current.apply(project);
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
      useAppStore.setState((s) => ({
        projectGeneration: s.projectGeneration + 1,
      }));
    }, 200);
  };

  const applyRemoteSnapshot = (project: GeoLibreProject, initial: boolean): void => {
    applyingRemoteRef.current = true;
    try {
      writeRemoteSnapshot(project, initial);
    } finally {
      applyingRemoteRef.current = false;
    }
  };

  const writeRemoteSnapshot = (project: GeoLibreProject, initial: boolean): void => {
    const state = useAppStore.getState();
    const localView = mapControllerRef.current?.readView() ?? state.mapView;
    const merged = mergeInboundCollaborationProject(project, localView, state.projectPlugins);
    // A deliberate exception to the regional-basemap prompt: the basemap is
    // shared state of a session the user chose to join, so it applies without
    // asking. A deployment block still applies, on the join and on every later
    // snapshot (see docs/deployment-policy.md#regional-basemaps).
    if (initial) {
      useAppStore.getState().loadProject(merged, null, {
        rememberRecent: false,
        presenting: false,
        trustBasemap: true,
      });
    } else {
      const applied = applyProjectToStore(merged);
      applied.layers = applied.layers.map((layer) =>
        rebaseImportedDocumentLayer(layer, state.nativeDocumentCopyRoot),
      );
      const gated = gateRegionalBasemap(
        applied.basemapStyleUrl,
        state.regionalBasemapPolicy,
        DEFAULT_BASEMAP,
        true,
      );
      applied.basemapStyleUrl = gated.styleUrl;
      // A peer switched the session to a basemap this deployment blocks: say
      // why this map differs, once per basemap rather than on every snapshot.
      if (
        gated.held === "blocked" &&
        basemapEgressRef.current.withheldStyleUrl() !== merged.basemapStyleUrl
      ) {
        notify.info(i18n.t("regionalBasemap.blockedNotice"), {
          dedupeKey: "regional-basemap-blocked",
        });
      }
      // Keep the layers update and the (deferred) generation bump separate:
      // bindNetcdfProfileSamplesToProject treats a bump that lands together
      // with new layers as a project switch and clears the inspected samples.
      useAppStore.setState({ ...applied });
      clearHistory();
      scheduleRestore();
    }
    basemapEgressRef.current.noteInbound(merged.basemapStyleUrl);
    lastContentRef.current = serializeProject(
      basemapEgressRef.current.apply(buildProjectEgressSnapshot(mapControllerRef)),
    );
  };

  const handleMessage = (message: ServerMessage): void => {
    const store = useAppStore.getState();
    switch (message.type) {
      case "welcome": {
        selfIdRef.current = message.clientId;
        welcomedRef.current = true;
        store.setCollaboration({
          isActive: true,
          connecting: false,
          clientId: message.clientId,
          role: message.role,
          mode: message.mode,
          participants: message.participants,
          chat: message.chat ?? [],
          requireIdentity: message.requireIdentity ?? false,
          identitySupported: message.identitySupported ?? false,
          lockedLayerIds: message.lockedLayerIds ?? [],
          invites: message.invites ?? [],
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
          void sendSnapshot();
        }
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
        store.addCollaborationChat(message.message);
        break;
      case "comment-mutation": {
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
      case "invite-created": {
        const current = useAppStore.getState().collaboration.invites;
        store.setCollaboration({ invites: [...current, message.invite] });
        break;
      }
      case "invite-revoked": {
        const current = useAppStore.getState().collaboration.invites;
        store.setCollaboration({
          invites: current.filter((i) => i.token !== message.token),
        });
        break;
      }
      case "session-config": {
        if (message.requireIdentity !== undefined) {
          store.setCollaboration({ requireIdentity: message.requireIdentity });
        }
        break;
      }
      case "layer-locks": {
        store.setCollaboration({ lockedLayerIds: message.lockedLayerIds });
        break;
      }
      case "kicked": {
        disconnect();
        useAppStore.getState().resetCollaboration();
        useAppStore.getState().setCollaboration({
          error: message.reason ?? "Removed from session.",
        });
        break;
      }
      case "error": {
        if (pendingConnectRef.current) {
          const pending = pendingConnectRef.current;
          pendingConnectRef.current = null;
          disconnect();
          store.setCollaboration({ connecting: false, error: message.message });
          pending.reject(new Error(message.message));
          return;
        }
        if (message.code === "layer-locked") {
          notifyLayerLockedRejection(message.message);
          break;
        }
        store.setCollaboration({ error: message.message });
        if (message.code === "too-large") syncPausedRef.current = true;
        break;
      }
    }
  };

  const attach = (
    displayName: string,
    color: string,
    hostToken: string | undefined,
    inviteToken?: string,
    identityToken?: string,
  ): void => {
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
      // Re-arm the view-only notice when edit rights return, even with no edit.
      if (state.collaboration !== prev.collaboration && canEdit())
        viewOnlyNoticeRef.current.reset();
      if (!projectChanged(state, prev)) return;
      scheduleSnapshot();
      viewOnlyNoticeRef.current.onLocalChange({
        active: state.collaboration.isActive,
        applyingRemote: applyingRemoteRef.current,
        canEdit: canEdit(),
      });
    });

    // CollabConnection reuses one object across reconnects, so a generation
    // tells a join for this socket from one a reconnect has superseded.
    const generation = ++joinGenerationRef.current;
    const sendJoin = (identity: string | null | undefined) => {
      if (connRef.current !== conn || joinGenerationRef.current !== generation) return;
      conn.send({
        type: "join",
        clientId: selfIdRef.current ?? crypto.randomUUID(),
        displayName,
        color,
        hostToken,
        inviteToken,
        ...(identity ? { identityToken: identity } : {}),
      });
      joinSentRef.current = true;
    };
    if (identityToken) {
      sendJoin(identityToken);
    } else {
      // Signed in to the server API: join as that account. The token is reused
      // across reconnects while it has a minute left. Worst case the join (and
      // so `connect()`) waits the lookup's 3 s deadline before going out
      // anonymously, as before.
      void import("../lib/collab-identity")
        .then(({ fetchCollabIdentityToken }) => fetchCollabIdentityToken())
        .catch(() => null)
        .then((token) => {
          if (connRef.current !== conn || joinGenerationRef.current !== generation) return;
          // If the session requires sign-in and refuses this join (the
          // lookup timed out, or a skewed clock kept an expired cached
          // token), try once more with a fresh token and a longer deadline.
          identityRetryRef.current = async () => {
            const { clearCollabIdentityCache, fetchCollabIdentityToken } =
              await import("../lib/collab-identity");
            clearCollabIdentityCache();
            const fresh = await fetchCollabIdentityToken({ timeoutMs: 10_000 }).catch(() => null);
            if (!fresh || connRef.current !== conn || joinGenerationRef.current !== generation) {
              return false;
            }
            sendJoin(fresh);
            return true;
          };
          sendJoin(token);
        });
    }

    teardownRef.current = () => {
      joinGenerationRef.current += 1;
      joinSentRef.current = false;
      identityRetryRef.current = null;
      welcomedRef.current = false;
      if (debounce) clearTimeout(debounce);
      unsubscribe();
    };
  };

  const bindPresence = (engine: MapEngine, conn: CollabConnection): (() => void) => {
    const surface = engine.getRenderSurface();
    if (!surface) return () => {};
    const container = surface.getContainer();
    let lastCursor = 0;
    // A reconnect keeps these listeners while its join may still wait on the
    // identity lookup; presence sent before the join would be dropped.
    const sendPresence = (message: Parameters<CollabConnection["send"]>[0]) => {
      if (joinSentRef.current) conn.send(message);
    };
    const onPointerMove = (event: PointerEvent) => {
      const now = Date.now();
      if (now - lastCursor < CURSOR_THROTTLE_MS) return;
      lastCursor = now;
      const bounds = container.getBoundingClientRect();
      const lngLat = surface.unproject([event.clientX - bounds.left, event.clientY - bounds.top]);
      if (lngLat)
        sendPresence({
          type: "presence",
          cursor: lngLat,
          view: engine.readView(),
        });
    };
    const onPointerLeave = () =>
      sendPresence({ type: "presence", cursor: null, view: engine.readView() });
    const onCameraIdle = (event?: { storyCamera: boolean }) => {
      if (event?.storyCamera) return;
      sendPresence({ type: "presence", view: engine.readView() });
    };
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerleave", onPointerLeave);
    const detachCameraIdle = engine.onCameraIdle(onCameraIdle);
    onCameraIdle();
    return () => {
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerleave", onPointerLeave);
      detachCameraIdle();
    };
  };

  const connect = (
    sessionId: string,
    displayName: string,
    color: string,
    hostToken: string | undefined,
    options?: { inviteToken?: string; identityToken?: string },
  ): Promise<void> => {
    disconnect();
    syncPausedRef.current = false;
    viewOnlyNoticeRef.current.reset();
    selfIdRef.current = crypto.randomUUID();
    lastContentRef.current = null;
    basemapEgressRef.current.reset();
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
      followHost: !hostToken,
      error: null,
    });

    return new Promise<void>((resolve, reject) => {
      pendingConnectRef.current = { resolve, reject };

      const conn = new CollabConnection(sessionWsUrl(baseUrl!, normalizedCode), {
        onOpen: () => {
          if (connRef.current !== conn) return;
          attach(displayName, color, hostToken, options?.inviteToken, options?.identityToken);
        },
        onMessage: (msg) => {
          if (connRef.current !== conn) return;
          if (
            msg.type === "error" &&
            msg.code === "identity-required" &&
            identityRetryRef.current
          ) {
            const retry = identityRetryRef.current;
            identityRetryRef.current = null;
            void retry().then((sent) => {
              if (!sent && connRef.current === conn) handleMessage(msg);
            });
            return;
          }
          if (msg.type !== "welcome" && msg.type !== "snapshot") {
            handleMessage(msg);
            return;
          }
          try {
            const incoming =
              msg.type === "welcome"
                ? msg.snapshot
                : msg.type === "snapshot" && msg.origin !== selfIdRef.current
                  ? msg.project
                  : null;
            if (incoming) {
              assertImportedDocumentCopiesAvailable(
                incoming.layers,
                useAppStore.getState().nativeDocumentCopyError,
              );
            }
            handleMessage(msg);
          } catch (error) {
            // Failed welcome/snapshot application must stop outbound sync.
            // Preserve the actual error and settle a pending join before the
            // unchanged local workspace can replace the peer's project.
            const pending = pendingConnectRef.current;
            pendingConnectRef.current = null;
            disconnect();
            const failure =
              error instanceof Error ? error : new Error(String(error), { cause: error });
            const message = failure.message;
            useAppStore
              .getState()
              .setCollaboration({ isActive: false, connecting: false, error: message });
            pending?.reject(failure);
            notify.error(message, { error: failure });
          }
        },
        onClose: (reconnecting) => {
          if (connRef.current && connRef.current !== conn) return;
          teardownRef.current?.();
          teardownRef.current = null;
          if (reconnecting && pendingConnectRef.current) {
            const p = pendingConnectRef.current;
            pendingConnectRef.current = null;
            conn.close();
            useAppStore.getState().setCollaboration({
              connecting: false,
              error: "Could not connect to the session.",
            });
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
    presenceTeardownRef.current?.();
    presenceTeardownRef.current = null;
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
    async (
      displayName: string,
      color: string,
      mode: CollaborationMode,
      requireIdentity?: boolean,
    ) => {
      const session = await createSession({ mode, requireIdentity }, baseUrl);
      await connect(session.sessionId, displayName, color, session.hostToken);
      return session.sessionId;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseUrl],
  );

  const join = useCallback(
    async (
      sessionId: string,
      displayName: string,
      color: string,
      options?: { inviteToken?: string; identityToken?: string },
    ) => {
      await connect(sessionId.trim().toUpperCase(), displayName, color, undefined, options);
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
    connRef.current?.send({
      type: "set-participant-mode",
      clientId,
      canEdit: canEditFlag,
    });
  }, []);

  const mintInvite = useCallback((role: CollaborationMode, maxUses?: number) => {
    connRef.current?.send({ type: "mint-invite", role, maxUses });
  }, []);

  const revokeInvite = useCallback((token: string) => {
    connRef.current?.send({ type: "revoke-invite", token });
  }, []);

  const setSessionConfig = useCallback((config: { requireIdentity?: boolean }) => {
    connRef.current?.send({ type: "set-session-config", ...config });
  }, []);

  const setLayerLocks = useCallback((lockedLayerIds: string[]) => {
    connRef.current?.send({ type: "set-layer-locks", lockedLayerIds });
  }, []);

  const kickParticipant = useCallback((clientId: string, reason?: string) => {
    connRef.current?.send({ type: "kick-participant", clientId, reason });
  }, []);

  const blockParticipant = useCallback((clientId: string, reason?: string) => {
    connRef.current?.send({ type: "block-participant", clientId, reason });
  }, []);

  const sendChat = useCallback((text: string, coordinate?: { lng: number; lat: number } | null) => {
    const trimmed = text.trim();
    if (!trimmed) return false;
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
    canEditLayer,
    start,
    join,
    leave,
    setMode,
    setParticipantMode,
    mintInvite,
    revokeInvite,
    setSessionConfig,
    setLayerLocks,
    kickParticipant,
    blockParticipant,
    setFollowHost,
    sendChat,
    sendCommentMutation,
  };
}
