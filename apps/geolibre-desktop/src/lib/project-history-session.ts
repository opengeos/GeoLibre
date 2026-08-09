import { DEFAULT_PROJECT_NAME } from "@geolibre/core";

const SESSION_KEY = "geolibre-project-session";
const TAB_KEY = "geolibre-project-session-tab";
const LAST_SAVE_KEY = "geolibre-project-last-explicit-save";
const LIVE_TAB_CHANNEL = "geolibre-project-session-live";
const LIVE_TAB_REPLY_MS = 250;

/**
 * How often a live tab restamps its session entry, and how long an entry
 * survives without being restamped.
 *
 * These exist because the session record is only ever written by the tab it
 * describes: a tab killed without `pagehide` (crash, OS kill, "Force Reload",
 * a mobile tab discarded under memory pressure) leaves its entry marked open
 * with nobody left to close it, and `readProjectSessionState` reports "open"
 * if *any* entry is. Without an expiry that one dead entry makes every later
 * visit look like it followed a crash, forever. The heartbeat is what makes a
 * long-lived tab distinguishable from a dead one: a tab open for hours keeps
 * restamping, so only the genuinely gone go stale. The gap between the two
 * values absorbs background-tab timer throttling, which browsers clamp to
 * roughly one call per minute.
 */
export const SESSION_HEARTBEAT_MS = 60_000;
const STALE_SESSION_MS = 5 * 60_000;

export interface ProjectSessionEntry {
  state: "open" | "closed";
  at: string;
}

export type ProjectSessionRecord = Record<string, ProjectSessionEntry>;

/**
 * Parse the stored session record, dropping anything unrecognizable.
 *
 * Entries written before sessions carried a timestamp (a bare `"open"`, either
 * as the whole value or per tab) are dropped rather than kept: their age is
 * unknowable, so treating them as live would preserve exactly the stuck-open
 * entries this expiry exists to clear.
 */
export function parseProjectSessions(stored: string | null): ProjectSessionRecord {
  if (!stored || stored === "open" || stored === "closed") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const sessions: ProjectSessionRecord = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const { state, at } = value as Partial<ProjectSessionEntry>;
    if ((state === "open" || state === "closed") && typeof at === "string") {
      sessions[id] = { state, at };
    }
  }
  return sessions;
}

/** Drop entries no live tab has restamped inside the expiry window. */
export function pruneStaleProjectSessions(
  sessions: ProjectSessionRecord,
  nowMs: number,
): ProjectSessionRecord {
  const fresh: ProjectSessionRecord = {};
  for (const [id, entry] of Object.entries(sessions)) {
    const at = Date.parse(entry.at);
    if (Number.isFinite(at) && at <= nowMs && nowMs - at <= STALE_SESSION_MS) fresh[id] = entry;
  }
  return fresh;
}

/**
 * "open" when some tab that was alive recently never closed cleanly.
 *
 * `liveTabIds` are tabs that just answered a liveness ping. A second window on
 * the same origin is the common case: it reads its sibling's perfectly healthy
 * heartbeat, which is indistinguishable in the record from a tab that stopped
 * heartbeating a moment ago, and would otherwise greet the user with a
 * recovery prompt every time they open a second GeoLibre tab. A tab that
 * answers is by definition not a crashed one, so its entry is discounted.
 */
export function projectSessionState(
  sessions: ProjectSessionRecord,
  nowMs: number,
  liveTabIds: ReadonlySet<string> = new Set(),
): "open" | "closed" {
  const recent = Object.entries(pruneStaleProjectSessions(sessions, nowMs));
  return recent.some(([id, entry]) => entry.state === "open" && !liveTabIds.has(id))
    ? "open"
    : "closed";
}

function currentTabId(): string {
  let id = sessionStorage.getItem(TAB_KEY);
  if (!id) {
    id =
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(TAB_KEY, id);
  }
  return id;
}

export function readProjectSessionState(liveTabIds?: ReadonlySet<string>): string | null {
  try {
    return projectSessionState(
      parseProjectSessions(localStorage.getItem(SESSION_KEY)),
      Date.now(),
      liveTabIds,
    );
  } catch (error) {
    console.error("Could not read the project session state.", error);
    return null;
  }
}

/**
 * Answer liveness pings from other tabs for as long as this tab is alive.
 *
 * Returns the teardown. Nothing is announced where `BroadcastChannel` is
 * missing; the caller then falls back to the record alone, which is what this
 * code did before the probe existed.
 */
export function announceLiveProjectSession(): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(LIVE_TAB_CHANNEL);
  channel.onmessage = (event: MessageEvent<{ type?: string } | null>) => {
    if (event.data?.type === "ping") channel.postMessage({ type: "alive", id: currentTabId() });
  };
  return () => channel.close();
}

/**
 * Ids of *other* tabs on this origin that answer a ping inside the reply window.
 *
 * This tab is excluded explicitly. A `BroadcastChannel` does not deliver to the
 * object that posted, but it does deliver to a second object in the same tab,
 * so the announcer above answers this tab's own ping. Keeping that answer would
 * be wrong in the one case that matters most: reloading the tab a renderer
 * crash just killed reuses its `sessionStorage` tab id, and discounting that id
 * would suppress the very prompt the user needs.
 */
export async function liveProjectSessionTabs(): Promise<Set<string>> {
  const live = new Set<string>();
  if (typeof BroadcastChannel === "undefined") return live;
  const channel = new BroadcastChannel(LIVE_TAB_CHANNEL);
  channel.onmessage = (event: MessageEvent<{ type?: string; id?: string } | null>) => {
    if (event.data?.type === "alive" && typeof event.data.id === "string") live.add(event.data.id);
  };
  try {
    channel.postMessage({ type: "ping" });
    await new Promise((resolve) => setTimeout(resolve, LIVE_TAB_REPLY_MS));
  } finally {
    channel.close();
  }
  live.delete(currentTabId());
  return live;
}

export function readLastExplicitProjectSave(): string | null {
  try {
    return localStorage.getItem(LAST_SAVE_KEY);
  } catch (error) {
    console.error("Could not read the last project save time.", error);
    return null;
  }
}

/**
 * Record this tab's session state, restamped to now.
 *
 * Writing also prunes: every other tab's expired entry is dropped here, so the
 * record cannot grow without bound and a crashed tab stops being counted.
 */
export function markProjectSession(state: "open" | "closed"): void {
  try {
    const now = Date.now();
    const sessions = pruneStaleProjectSessions(
      parseProjectSessions(localStorage.getItem(SESSION_KEY)),
      now,
    );
    sessions[currentTabId()] = { state, at: new Date(now).toISOString() };
    localStorage.setItem(SESSION_KEY, JSON.stringify(sessions));
  } catch (error) {
    console.error("Could not persist the project session state.", error);
  }
}

/** The snapshot fields the recovery decision looks at. */
export interface ProjectRecoveryCandidate {
  createdAt: string;
  name: string;
  projectKey?: string;
}

/**
 * Whether the crash-recovery prompt should be offered for `candidate`.
 *
 * A snapshot only qualifies when the previous session never marked itself
 * closed, when the snapshot is newer than the last explicit save, and when it
 * belongs to a project the user has actually claimed: one with a path, or one
 * they renamed. An autosave of a still-default-named,
 * never-saved project is throwaway state: on the web build every visit starts
 * as "Untitled Project", and a `pagehide` that never fires (or a tab whose
 * session id is gone) leaves the session marked open forever, so recovery
 * would prompt on every single visit for work nobody asked to keep.
 */
export function shouldOfferProjectRecovery(
  candidate: ProjectRecoveryCandidate | undefined,
  sessionState: string | null,
  lastExplicitSave: string | null,
): boolean {
  if (!candidate || sessionState !== "open") return false;
  if (lastExplicitSave && candidate.createdAt <= lastExplicitSave) return false;
  if (candidate.projectKey?.startsWith("path:")) return true;
  return candidate.name !== DEFAULT_PROJECT_NAME;
}

export function recordExplicitProjectSave(): void {
  try {
    localStorage.setItem(LAST_SAVE_KEY, new Date().toISOString());
  } catch (error) {
    console.error("Could not persist the last project save time.", error);
  }
}
