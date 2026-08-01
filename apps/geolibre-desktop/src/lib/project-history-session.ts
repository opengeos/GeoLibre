const SESSION_KEY = "geolibre-project-session";
const LAST_SAVE_KEY = "geolibre-project-last-explicit-save";

export function readProjectSessionState(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
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
    localStorage.setItem(SESSION_KEY, state);
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
