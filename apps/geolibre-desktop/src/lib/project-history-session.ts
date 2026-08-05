const SESSION_KEY = "geolibre-project-session";
const TAB_KEY = "geolibre-project-session-tab";
const LAST_SAVE_KEY = "geolibre-project-last-explicit-save";

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

function readSessions(): Record<string, "open" | "closed"> {
  const stored = localStorage.getItem(SESSION_KEY);
  if (!stored) return {};
  if (stored === "open" || stored === "closed") return { legacy: stored };
  try {
    return JSON.parse(stored) as Record<string, "open" | "closed">;
  } catch {
    return {};
  }
}

export function readProjectSessionState(): string | null {
  try {
    return Object.values(readSessions()).includes("open") ? "open" : "closed";
  } catch (error) {
    console.error("Could not read the project session state.", error);
    return null;
  }
}

export function readLastExplicitProjectSave(): string | null {
  try {
    return localStorage.getItem(LAST_SAVE_KEY);
  } catch (error) {
    console.error("Could not read the last project save time.", error);
    return null;
  }
}

export function markProjectSession(state: "open" | "closed"): void {
  try {
    const sessions = readSessions();
    delete sessions.legacy;
    sessions[currentTabId()] = state;
    localStorage.setItem(SESSION_KEY, JSON.stringify(sessions));
  } catch (error) {
    console.error("Could not persist the project session state.", error);
  }
}

export function recordExplicitProjectSave(): void {
  try {
    localStorage.setItem(LAST_SAVE_KEY, new Date().toISOString());
  } catch (error) {
    console.error("Could not persist the last project save time.", error);
  }
}
