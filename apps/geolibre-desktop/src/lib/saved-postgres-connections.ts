/**
 * Persistence for the PostgreSQL connection strings the user has entered:
 * a small localStorage-backed MRU list, plus the password-masked label used
 * to show (and later match) a connection without exposing its credentials.
 *
 * Pure data utilities, deliberately UI-free: consumed both by the Add Data
 * dialog and by the PostGIS layer connection registry in
 * `postgis-connections.ts`.
 */

export const POSTGRES_CONNECTIONS_STORAGE_KEY = "geolibre.postgres.connectionStrings";
export const MAX_SAVED_POSTGRES_CONNECTIONS = 10;

/**
 * Fired on `window` after the saved-connections list is written, so same-tab
 * views (e.g. the Browser panel's Databases section) can re-read it — the
 * native `storage` event only fires cross-tab.
 */
export const POSTGRES_CONNECTIONS_CHANGED_EVENT = "geolibre:postgres-connections-changed";

export function uniquePostgresConnections(connections: string[]): string[] {
  return Array.from(new Set(connections));
}

export function readSavedPostgresConnections(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = window.localStorage.getItem(POSTGRES_CONNECTIONS_STORAGE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? uniquePostgresConnections(parsed.filter((item): item is string => typeof item === "string"))
      : [];
  } catch {
    return [];
  }
}

export function rememberPostgresConnection(connectionString: string): string[] {
  const trimmed = connectionString.trim();
  if (!trimmed || typeof window === "undefined") return [];

  const connections = uniquePostgresConnections([
    trimmed,
    ...readSavedPostgresConnections().filter((value) => value !== trimmed),
  ]).slice(0, MAX_SAVED_POSTGRES_CONNECTIONS);

  try {
    window.localStorage.setItem(POSTGRES_CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
    // Notify same-tab listeners (the Browser panel) so a newly-saved connection
    // appears without closing and reopening the panel.
    window.dispatchEvent(new Event(POSTGRES_CONNECTIONS_CHANGED_EVENT));
  } catch {
    // Best-effort persistence: a quota/private-mode failure must not abort the
    // connect flow (mirrors readSavedPostgresConnections' guard).
  }
  return connections;
}

export function savedPostgresConnectionLabel(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = "****";
    return url.toString();
  } catch {
    return connectionString
      .replace(/(:\/\/[^:\s/@]+:)[^@\s]+@/, "$1****@")
      .replace(/(password\s*=\s*)('[^']*'|[^\s]+)/gi, "$1****");
  }
}
