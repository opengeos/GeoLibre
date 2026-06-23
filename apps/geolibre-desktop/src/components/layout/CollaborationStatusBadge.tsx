import { useAppStore } from "@geolibre/core";
import { Button } from "@geolibre/ui";
import { ChevronUp, Settings2, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface Announcement {
  id: number;
  text: string;
}

// How long a join/leave announcement stays on screen before auto-dismissing.
const ANNOUNCEMENT_TTL_MS = 5000;

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
export function CollaborationStatusBadge() {
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
  const setCollaborateDialogOpen = useAppStore(
    (s) => s.setCollaborateDialogOpen,
  );
  // Shares the bottom-left corner with the MapLibre scale control and the
  // bounds-restriction badge, so lift the badge above whichever of those is
  // showing (see the positioning note below).
  const restrictBounds = useAppStore((s) => s.preferences.map.restrictBounds);

  const [expanded, setExpanded] = useState(false);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
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
      return;
    }
    const current = new Map(
      participants.map((p) => [p.clientId, p.displayName]),
    );
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
      <div
        className="flex flex-col gap-1"
        role="log"
        aria-label={t("collaborate.announcements")}
      >
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
          <ul className="max-h-48 space-y-1 overflow-y-auto p-2">
            {participants.map((p) => (
              <li
                key={p.clientId}
                className="flex items-center gap-2 text-xs"
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: p.color }}
                />
                <span className="truncate">{p.displayName}</span>
                {p.clientId === selfId && (
                  <span className="text-muted-foreground">
                    ({t("collaborate.you")})
                  </span>
                )}
                {p.role === "host" && (
                  <span className="rounded bg-muted px-1 py-0.5 text-[10px]">
                    {t("collaborate.host")}
                  </span>
                )}
              </li>
            ))}
          </ul>
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
              <Settings2 className="mr-2 h-3.5 w-3.5" />
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
        // Describe the action the click performs, which flips with state.
        aria-label={
          expanded
            ? t("collaborate.collapseRoster")
            : t("collaborate.sessionStatusTooltip")
        }
        title={
          expanded
            ? t("collaborate.collapseRoster")
            : t("collaborate.sessionStatusTooltip")
        }
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
        {/* The roster grows upward above the pill: point up when collapsed
            ("reveal above"), down when expanded ("collapse"). */}
        <ChevronUp
          className={`h-3 w-3 transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
