/** Device-local map chrome, independent of project data and capture drafts. */
const STORAGE_KEY = "geolibre:control-visibility";

export function readControlPreference(key: string, fallback: boolean): boolean {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return typeof value?.[key] === "boolean" ? value[key] : fallback;
  } catch {
    return fallback;
  }
}

export function writeControlPreference(key: string, visible: boolean): void {
  try {
    let value: Record<string, boolean> = {};
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      if (stored && typeof stored === "object" && !Array.isArray(stored)) value = stored;
    } catch {
      // Replace malformed preferences on the next explicit user choice.
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...value, [key]: visible }));
  } catch {
    // A blocked or full storage area must not prevent using a control.
  }
}
