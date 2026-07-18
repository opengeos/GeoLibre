import { useAppStore } from "@geolibre/core";
import { Button, Input } from "@geolibre/ui";
import type { MapController } from "@geolibre/map";
import { ChevronUp, MapPin, Send, Settings2, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RefObject } from "react";
import type { CollaborationApi } from "../../hooks/useCollaboration";
import { CollaborationParticipantRow } from "./CollaborationParticipantRow";

interface Announcement {
  id: number;
  text: string;
}

interface CollaborationStatusBadgeProps {
  api: CollaborationApi;
  mapControllerRef: RefObject<MapController | null>;
}

// How long a join/leave announcement stays on screen before auto-dismissing.
const ANNOUNCEMENT_TTL_MS = 5000;
// Client-side chat send floor, matching the relay's per-socket limit, so a
// rapid second send is refused locally (keeping its draft) rather than sent and
// silently dropped by the relay.
const MIN_CHAT_SEND_INTERVAL_MS = 250;

/**
 * Persistent on-canvas badge that surfaces a live collaboration session outside
 * the Collaborate dialog (#754). It shows only while a session is active and:
 *
 * - displays a pulsing "live" dot plus the connected-participant count, so the
 *   host knows the session is still running after dismissing the dialog;
 * - expands into a roster of connected clients with a shortcut back to the full
 *   Collaborate dialog (reopened via the store so this badge can drive it from
 *   outside the toolbar tree);
 * - briefly announces when someone joins or leaves.
 *
 * Anchored bottom-left (top-left is where map-control plugins cluster), lifted
 * above the MapLibre scale control (and the bounds-restriction badge when it is
 * showing); the roster and announcements grow upward from the collapsed pill.
 */
export function CollaborationStatusBadge({ api, mapControllerRef }: CollaborationStatusBadgeProps) {
  const { t } = useTranslation();
  // Narrow selectors rather than the whole `collaboration` slice: remote cursor
  // presence updates that slice many times per second, and subscribing to the
  // whole object would re-render this badge on every pointer move even though it
  // never renders presence.
  const isActive = useAppStore((s) => s.collaboration.isActive);
  const connecting = useAppStore((s) => s.collaboration.connecting);
  const participants = useAppStore((s) => s.collaboration.participants);
  // `clientId` is typed `string | null`; fall back to an empty-string sentinel
  // so the `id !== selfId` self-filtering below never treats a null id as "not
  // me" and announces the local user joining. Server client ids are UUIDs, so
  // "" can never collide with a real participant.
  const selfId = useAppStore((s) => s.collaboration.clientId) ?? "";
  // Narrow selectors (see above): role/mode gate the host-only permission
  // toggles; chat drives the message drawer. None update on cursor moves.
  const role = useAppStore((s) => s.collaboration.role);
  const mode = useAppStore((s) => s.collaboration.mode);
  // Default to [] defensively: a relay that predates the chat protocol can send
  // a `welcome` without `chat`, and an undefined slice would crash this badge
  // (and, since it renders inside the map's error boundary, the whole map).
  const chat = useAppStore((s) => s.collaboration.chat) ?? [];
  const isHost = role === "host";
  const setCollaborateDialogOpen = useAppStore((s) => s.setCollaborateDialogOpen);
  // Shares the bottom-left corner with the MapLibre scale control and the
  // bounds-restriction badge, so lift the badge above whichever of those is
  // showing (see the positioning note below). The KnowledgeCardPanel also opens
  // in this corner, but as a large transient z-20 panel it overlays this z-10
  // badge while open rather than participating in this stacking.
  const restrictBounds = useAppStore((s) => s.preferences.map.restrictBounds);

  const [expanded, setExpanded] = useState(false);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  // Chat composer: the draft text and whether to attach the current map center
  // (#754, Part 4). The pin captures the center at send time, not toggle time.
  const [draft, setDraft] = useState("");
  const [attachLocation, setAttachLocation] = useState(false);
  // Epoch-ms of the last accepted local send, for the client-side floor above.
  const lastSentAtRef = useRef(0);
  // The scroll viewport for the message list, so new messages pin to the bottom.
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  // Unread chat count while the roster is collapsed, surfaced on the pill so a
  // working host notices new messages without keeping the panel open. Tracked by
  // the last-seen message id (not the array length): the store keeps a bounded
  // tail, so once it is full new messages arrive without changing the length.
  const [unread, setUnread] = useState(0);
  // `undefined` = not yet initialised for this session; `null` = initialised
  // against an empty chat. These must be distinct so the very first message in
  // an empty session is still counted as unread (a single `null` sentinel would
  // re-seed on that first message and swallow it).
  const lastSeenChatIdRef = useRef<string | null | undefined>(undefined);
  // The participant set from the previous update, so we can diff join/leave.
  // Seeded on first activation so existing members (and self) aren't announced
  // as fresh arrivals when the dialog first connects.
  const knownRef = useRef<Map<string, string> | null>(null);
  const announceIdRef = useRef(0);
  const timersRef = useRef<number[]>([]);
  // The previous render's selfId. A transparent reconnect can rotate clientId
  // while isActive stays true; without remembering the old id, the diff below
  // would see the old self-id drop out of the roster and announce "you left".
  const prevSelfIdRef = useRef(selfId);

  // Clear any pending auto-dismiss timers on unmount.
  useEffect(
    () => () => {
      for (const id of timersRef.current) window.clearTimeout(id);
      timersRef.current = [];
    },
    [],
  );

  useEffect(() => {
    if (!isActive) {
      // Session ended: cancel any pending auto-dismiss timers from the previous
      // session and reset so the next one starts clean (and we don't announce
      // its initial roster against a stale previous one).
      for (const id of timersRef.current) window.clearTimeout(id);
      timersRef.current = [];
      knownRef.current = null;
      setExpanded(false);
      setAnnouncements([]);
      // Reset the chat composer so a fresh session starts clean.
      setDraft("");
      setAttachLocation(false);
      setUnread(0);
      lastSeenChatIdRef.current = undefined;
      return;
    }
    const current = new Map(participants.map((p) => [p.clientId, p.displayName]));
    const known = knownRef.current;
    knownRef.current = current;
    const prevSelfId = prevSelfIdRef.current;
    prevSelfIdRef.current = selfId;
    // First roster for this session: seed silently. This also doubles as a
    // buffer for the live region below, which only mounts while a session is
    // active: this early return guarantees at least one render with the region
    // present-but-empty before any announcement text is injected, so assistive
    // tech (notably JAWS, which registers live regions at mount) has discovered
    // it first.
    if (known === null) return;

    const fresh: Announcement[] = [];
    for (const [id, name] of current) {
      if (id !== selfId && !known.has(id)) {
        fresh.push({
          id: announceIdRef.current++,
          text: t("collaborate.participantJoined", { name }),
        });
      }
    }
    for (const [id, name] of known) {
      // Skip both the current and previous self-id so a clientId rotation
      // during a transparent reconnect doesn't announce "you left".
      if (id === selfId || id === prevSelfId) continue;
      if (!current.has(id)) {
        fresh.push({
          id: announceIdRef.current++,
          text: t("collaborate.participantLeft", { name }),
        });
      }
    }
    if (fresh.length === 0) return;
    setAnnouncements((prev) => [...prev, ...fresh]);
    for (const a of fresh) {
      const timer = window.setTimeout(() => {
        setAnnouncements((prev) => prev.filter((x) => x.id !== a.id));
        // Drop the fired timer so the array stays bounded over a long session.
        timersRef.current = timersRef.current.filter((id) => id !== timer);
      }, ANNOUNCEMENT_TTL_MS);
      timersRef.current.push(timer);
    }
  }, [isActive, participants, selfId, t]);

  // Let Escape close the expanded roster, matching the dismissal convention of
  // dialogs and popovers elsewhere. Click-outside is intentionally not wired up:
  // the panel floats over the map, which users click constantly, so dismissing
  // on every map interaction would be more annoying than helpful.
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  // The latest message's id; effects key on this (not chat.length) so a full,
  // bounded tail still notices new arrivals.
  const lastMessageId = chat.length ? chat[chat.length - 1].id : null;

  // Track unread chat while the panel is collapsed; clear it (and remember the
  // latest message id) whenever the panel is open, so the badge counts only
  // messages that arrived while the host wasn't looking. The first collapsed
  // render of a session seeds the baseline so welcome history isn't unread.
  useEffect(() => {
    if (!isActive) return;
    if (expanded || lastSeenChatIdRef.current === undefined) {
      lastSeenChatIdRef.current = lastMessageId;
      setUnread(0);
      return;
    }
    const seenIdx = chat.findIndex((m) => m.id === lastSeenChatIdRef.current);
    // If the last-seen message has aged out of the tail, every retained message
    // is newer than it.
    setUnread(seenIdx === -1 ? chat.length : chat.length - seenIdx - 1);
  }, [isActive, expanded, lastMessageId, chat]);

  // Keep the message list pinned to the latest message while the panel is open.
  // On open, always jump to the bottom (show the latest). For a message that
  // arrives while it is already open, only auto-scroll when the user is at (or
  // near) the bottom — otherwise a new message would yank them away from history
  // they scrolled up to read.
  const prevExpandedRef = useRef(false);
  useEffect(() => {
    if (!expanded) {
      prevExpandedRef.current = false;
      return;
    }
    const el = chatScrollRef.current;
    if (!el) return;
    const justOpened = !prevExpandedRef.current;
    prevExpandedRef.current = true;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (justOpened || nearBottom) el.scrollTop = el.scrollHeight;
  }, [expanded, lastMessageId]);

  const handleSendChat = () => {
    const text = draft.trim();
    // Drop sends while reconnecting: api.sendChat silently no-ops when the
    // socket isn't open, so clearing the draft here would lose the typed text.
    if (!text || connecting) return;
    // Mirror the relay's per-socket chat floor client-side: if two sends land
    // within the window the relay would silently drop the second, so refuse it
    // here WITHOUT clearing the draft, rather than clearing optimistically and
    // losing the text. (Human-paced typing never hits this; double-Enter does.)
    const now = Date.now();
    if (now - lastSentAtRef.current < MIN_CHAT_SEND_INTERVAL_MS) return;
    // Capture the live map center only when the pin is active, at send time.
    const center =
      attachLocation && mapControllerRef.current
        ? mapControllerRef.current.getMap()?.getCenter()
        : null;
    const sent = api.sendChat(text, center ? { lng: center.lng, lat: center.lat } : null);
    // Only clear the composer (and stamp the floor) when the message actually
    // reached an open socket; otherwise keep the draft so a transient
    // disconnect doesn't lose it.
    if (!sent) return;
    lastSentAtRef.current = now;
    setDraft("");
    setAttachLocation(false);
  };

  const flyToCoordinate = (coordinate: { lng: number; lat: number }) => {
    mapControllerRef.current?.getMap()?.flyTo({ center: [coordinate.lng, coordinate.lat] });
  };

  if (!isActive) return null;

  return (
    <div
      className={`pointer-events-none absolute left-2 z-10 flex w-60 max-w-[calc(100%-1rem)] flex-col gap-1.5 ${
        // Clear the bottom-left scale control (~32px tall); when the
        // bounds-restriction badge (bottom-12) is also showing, sit above it
        // instead of overlapping. The roster/announcements grow upward.
        restrictBounds ? "bottom-20" : "bottom-10"
      }`}
    >
      {/* Transient join/leave announcements, stacked just above the pill. The
          live region stays mounted at all times (even when empty) and only its
          content changes, so screen readers reliably pick up each insertion.
          role="log" (aria-atomic="false") announces only the newly added entry,
          rather than re-reading the whole region the way role="status" would. */}
      <div className="flex flex-col gap-1" role="log" aria-label={t("collaborate.announcements")}>
        {announcements.map((a) => (
          <div
            key={a.id}
            className="pointer-events-auto flex items-center gap-1.5 rounded-md border bg-background/95 px-2 py-1 text-xs text-foreground shadow-sm backdrop-blur-sm"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
            <span className="truncate">{a.text}</span>
          </div>
        ))}
      </div>

      {/* Expanded roster: who is connected, plus a way back to the dialog. */}
      {expanded && (
        <div
          id="collab-roster-panel"
          className="pointer-events-auto rounded-md border bg-background/95 shadow-md backdrop-blur-sm"
        >
          <div className="flex items-center justify-between border-b px-2.5 py-1.5">
            <span className="text-xs font-medium">
              {t("collaborate.participants", {
                count: participants.length,
              })}
            </span>
            <button
              type="button"
              aria-label={t("common.close")}
              onClick={() => setExpanded(false)}
              className="rounded-sm p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <ul className="max-h-40 space-y-1 overflow-y-auto p-2">
            {participants.map((p) => (
              <CollaborationParticipantRow
                key={p.clientId}
                participant={p}
                mode={mode}
                isSelf={p.clientId === selfId}
                canManage={isHost}
                onSetParticipantMode={api.setParticipantMode}
                compact
              />
            ))}
          </ul>

          {/* Chat drawer (#754, Part 4): a lightweight text channel with an
              optional attached map coordinate that recenters on click. */}
          <div className="flex flex-col border-t">
            <div
              ref={chatScrollRef}
              className="flex max-h-40 min-h-[3rem] flex-col gap-1.5 overflow-y-auto p-2"
              role="log"
              aria-label={t("collaborate.chatLog")}
            >
              {chat.length === 0 ? (
                <p className="px-1 py-2 text-center text-[11px] text-muted-foreground">
                  {t("collaborate.chatEmpty")}
                </p>
              ) : (
                chat.map((m) => {
                  // Bind to a const so the narrowing survives into the onClick
                  // closure (a non-null assertion would otherwise be needed).
                  const coord = m.coordinate;
                  return (
                    <div key={m.id} className="flex flex-col gap-0.5 text-xs">
                      <div className="flex items-baseline gap-1.5">
                        <span className="truncate font-medium" style={{ color: m.color }}>
                          {m.clientId === selfId ? t("collaborate.you") : m.displayName}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap break-words text-foreground">{m.text}</p>
                      {coord && (
                        <button
                          type="button"
                          onClick={() => flyToCoordinate(coord)}
                          className="flex w-fit items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
                          title={t("collaborate.chatGoToLocation")}
                        >
                          <MapPin className="h-3 w-3" aria-hidden="true" />
                          {coord.lat.toFixed(4)}, {coord.lng.toFixed(4)}
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            <div className="flex items-center gap-1 border-t p-1.5">
              <button
                type="button"
                onClick={() => setAttachLocation((v) => !v)}
                aria-pressed={attachLocation}
                title={
                  attachLocation
                    ? t("collaborate.chatLocationAttached")
                    : t("collaborate.chatAttachLocation")
                }
                className={`flex shrink-0 items-center rounded p-1.5 transition ${
                  attachLocation
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSendChat();
                  } else if (e.key === "Escape") {
                    // Don't let Escape bubble to the window listener that
                    // collapses the panel — while typing it should stay open.
                    e.stopPropagation();
                  }
                }}
                placeholder={t("collaborate.chatPlaceholder")}
                maxLength={2000}
                aria-label={t("collaborate.chatCompose")}
                className="h-8 text-xs"
              />
              <Button
                type="button"
                size="sm"
                className="h-8 shrink-0 px-2"
                disabled={connecting || !draft.trim()}
                onClick={handleSendChat}
                aria-label={t("collaborate.chatSend")}
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div className="border-t p-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={() => {
                // Collapse the roster as the dialog takes over, so dismissing
                // the dialog returns to a clean map rather than a stray panel.
                setCollaborateDialogOpen(true);
                setExpanded(false);
              }}
            >
              <Settings2 className="me-2 h-3.5 w-3.5" />
              {t("collaborate.manageSession")}
            </Button>
          </div>
        </div>
      )}

      {/* Collapsed pill, always visible while the session is live. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        // Only reference the roster while it is mounted (it is conditionally
        // rendered when collapsed), so the id target always exists.
        aria-controls={expanded ? "collab-roster-panel" : undefined}
        // Describe the action the click performs, which flips with state. When
        // collapsed with unread chat, fold the count into the label so it is
        // announced rather than conveyed by the badge color alone.
        aria-label={
          expanded
            ? t("collaborate.collapseRoster")
            : unread > 0
              ? t("collaborate.sessionStatusUnread", { count: unread })
              : t("collaborate.sessionStatusTooltip")
        }
        title={expanded ? t("collaborate.collapseRoster") : t("collaborate.sessionStatusTooltip")}
        className="pointer-events-auto flex items-center gap-1.5 self-start rounded-full border bg-background/95 px-2.5 py-1 text-xs font-medium text-foreground shadow-sm backdrop-blur-sm transition hover:bg-accent"
      >
        <span className="relative flex h-2 w-2" aria-hidden="true">
          {!connecting && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-60" />
          )}
          <span
            className={`relative inline-flex h-2 w-2 rounded-full ${
              connecting ? "bg-amber-500" : "bg-green-500"
            }`}
          />
        </span>
        <Users className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{participants.length}</span>
        {/* Unread-chat count while collapsed, so a working host sees new
            messages without keeping the panel open. */}
        {!expanded && unread > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
        {/* The roster grows upward above the pill: point up when collapsed
            ("reveal above"), down when expanded ("collapse"). */}
        <ChevronUp
          className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
