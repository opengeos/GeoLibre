/**
 * Persistence for the PostgreSQL connection strings the user has entered:
 * a small MRU list, plus the password-masked label used to show (and later
 * match) a connection without exposing its credentials.
 *
 * The web build and the mobile apps keep the list in localStorage. The desktop
 * build (issue #1667) keeps each DSN as its own OS credential-store entry
 * (`postgres.connection.<uuid>`) and only the non-secret MRU order of those
 * ids in localStorage. Pending desktop deletions are recorded by id and
 * retried on startup; re-saving a forgotten DSN uses a fresh id.
 * `credential-hydration.ts` loads that list into memory before the app renders,
 * so readers stay synchronous.
 *
 * Pure data utilities, deliberately UI-free: consumed both by the Add Data
 * dialog and by the PostGIS layer connection registry in
 * `postgis-connections.ts`.
 */
import {
  credentialStorageLocation,
  deleteSecureCredentialAfterQueue,
  queueCredentialChanges,
  reportCredentialStorageError,
} from "./credential-store";

/** Web/mobile list; on desktop, only legacy plaintext awaiting migration. */
export const POSTGRES_CONNECTIONS_STORAGE_KEY = "geolibre.postgres.connectionStrings";
/** Desktop: non-secret JSON array of connection ids in MRU order. */
export const POSTGRES_CONNECTION_IDS_STORAGE_KEY = "geolibre.postgres.connectionIds";
/** Desktop: non-secret JSON array of connection ids whose keychain entry is still to be deleted. */
export const POSTGRES_PENDING_DELETION_IDS_STORAGE_KEY = "geolibre.postgres.pendingDeletionIds";
export const MAX_SAVED_POSTGRES_CONNECTIONS = 10;

/**
 * Fired on `window` after the saved-connections list changes, so same-tab
 * views (e.g. the Browser panel's Databases section) can re-read it — the
 * native `storage` event only fires cross-tab.
 */
export const POSTGRES_CONNECTIONS_CHANGED_EVENT = "geolibre:postgres-connections-changed";

const CONNECTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface KeychainPostgresConnection {
  id: string;
  connection: string;
}

/** Desktop cache of the credential-store list; null until hydrated. */
let keychainConnections: KeychainPostgresConnection[] | null = null;
/** False after a failed startup migration: edits then stay in memory. */
let postgresKeychainWritable = true;

function readPendingPostgresDeletionIds(): string[] {
  const value = window.localStorage.getItem(POSTGRES_PENDING_DELETION_IDS_STORAGE_KEY);
  if (value === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("The pending PostGIS credential deletions list is malformed.");
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((id): id is string => typeof id === "string" && CONNECTION_ID_PATTERN.test(id))
  ) {
    throw new Error("The pending PostGIS credential deletions list is malformed.");
  }
  return [...new Set(parsed)];
}

function writePendingPostgresDeletionIds(ids: string[]): void {
  if (ids.length === 0) {
    window.localStorage.removeItem(POSTGRES_PENDING_DELETION_IDS_STORAGE_KEY);
  } else {
    window.localStorage.setItem(POSTGRES_PENDING_DELETION_IDS_STORAGE_KEY, JSON.stringify(ids));
  }
}

const postgresCredentialDeletions = new Map<string, Promise<boolean>>();

function deletePostgresCredential(id: string): Promise<boolean> {
  const existing = postgresCredentialDeletions.get(id);
  if (existing) return existing;
  const deletion = performPostgresCredentialDeletion(id).finally(() => {
    postgresCredentialDeletions.delete(id);
  });
  postgresCredentialDeletions.set(id, deletion);
  return deletion;
}

async function performPostgresCredentialDeletion(id: string): Promise<boolean> {
  try {
    await deleteSecureCredentialAfterQueue(postgresConnectionAccount(id));
  } catch {
    return false;
  }
  try {
    writePendingPostgresDeletionIds(
      readPendingPostgresDeletionIds().filter((pendingId) => pendingId !== id),
    );
  } catch (error) {
    reportCredentialStorageError(error);
  }
  return true;
}

/**
 * Retry durable deletion records, sharing any delete already in flight.
 * Discard markers for still-indexed connections without deleting their secrets:
 * those forgets never committed the saved-list update.
 */
export async function resumePostgresCredentialDeletions(): Promise<string[]> {
  return retryPendingPostgresCredentialDeletions();
}

async function retryPendingPostgresCredentialDeletions(excludeId?: string): Promise<string[]> {
  if (
    credentialStorageLocation() !== "keychain" ||
    !postgresKeychainWritable ||
    keychainConnections === null
  ) {
    return [];
  }
  let ids: string[];
  try {
    ids = readPendingPostgresDeletionIds();
  } catch (error) {
    reportCredentialStorageError(error);
    return [];
  }

  const indexedIds = new Set(keychainConnections.map(({ id }) => id));
  const deletions = ids.filter((id) => !indexedIds.has(id));
  const stillIndexed = ids.filter((id) => indexedIds.has(id));
  if (stillIndexed.length > 0) {
    // These ids never left the saved index, so the forget did not commit.
    // Retain their credentials and discard only the now-stale retry markers.
    try {
      writePendingPostgresDeletionIds(deletions);
    } catch (error) {
      reportCredentialStorageError(error);
    }
  }

  const failed: string[] = [];
  for (const id of deletions) {
    if (id !== excludeId && !(await deletePostgresCredential(id))) failed.push(id);
  }
  return failed;
}

export function uniquePostgresConnections(connections: string[]): string[] {
  return Array.from(new Set(connections));
}

export function postgresConnectionAccount(id: string): string {
  return `postgres.connection.${id}`;
}

/**
 * Reads the desktop id index. Throws on unreadable storage or a malformed
 * index rather than returning a partial list, which would orphan entries.
 */
export function readKeychainPostgresIds(): string[] {
  const value = window.localStorage.getItem(POSTGRES_CONNECTION_IDS_STORAGE_KEY);
  if (value === null) return [];
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length > MAX_SAVED_POSTGRES_CONNECTIONS ||
    new Set(parsed).size !== parsed.length ||
    !parsed.every((id) => typeof id === "string" && CONNECTION_ID_PATTERN.test(id))
  ) {
    throw new Error("The saved PostGIS connection index is malformed.");
  }
  return parsed as string[];
}

export function postgresConnectionSecrets(
  entries: readonly KeychainPostgresConnection[],
): Record<string, string> {
  return Object.fromEntries(
    entries.map(({ id, connection }) => [postgresConnectionAccount(id), connection]),
  );
}

export function setKeychainPostgresConnections(entries: KeychainPostgresConnection[]): void {
  keychainConnections = entries.map((entry) => ({ ...entry }));
  window.dispatchEvent(new Event(POSTGRES_CONNECTIONS_CHANGED_EVENT));
}

export function setPostgresKeychainWritable(writable: boolean): void {
  postgresKeychainWritable = writable;
}

/** The localStorage list: the web/mobile store, legacy plaintext on desktop. */
export function readBrowserPostgresConnections(): string[] {
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

export function readSavedPostgresConnections(): string[] {
  if (credentialStorageLocation() === "browser") return readBrowserPostgresConnections();
  return keychainConnections?.map(({ connection }) => connection) ?? [];
}

export interface PostgresConnectionForgetResult {
  /** The saved list after removal. */
  connections: string[];
  /** True once no saved secret remains; false when the keychain refused and deletion is retried at next startup. */
  credentialDeleted: Promise<boolean>;
}

export class PostgresConnectionForgetError extends Error {
  constructor() {
    super("The saved PostgreSQL connection list could not be updated.");
    this.name = "PostgresConnectionForgetError";
  }
}

export function forgetPostgresConnection(connectionString: string): PostgresConnectionForgetResult {
  if (typeof window === "undefined") {
    return { connections: [], credentialDeleted: Promise.resolve(true) };
  }

  if (credentialStorageLocation() === "keychain") {
    if (!postgresKeychainWritable || keychainConnections === null) {
      throw new PostgresConnectionForgetError();
    }
    const entry = keychainConnections.find(({ connection }) => connection === connectionString);
    if (!entry) {
      return {
        connections: readSavedPostgresConnections(),
        credentialDeleted: Promise.resolve(true),
      };
    }
    try {
      writePendingPostgresDeletionIds([
        ...new Set([...readPendingPostgresDeletionIds(), entry.id]),
      ]);
    } catch (error) {
      reportCredentialStorageError(error);
      throw new PostgresConnectionForgetError();
    }

    const next = keychainConnections.filter(({ id }) => id !== entry.id);
    try {
      window.localStorage.setItem(
        POSTGRES_CONNECTION_IDS_STORAGE_KEY,
        JSON.stringify(next.map(({ id }) => id)),
      );
    } catch (error) {
      reportCredentialStorageError(error);
      postgresKeychainWritable = false;
      throw new PostgresConnectionForgetError();
    }
    setKeychainPostgresConnections(next);
    // Retry older records first; the shared deletion map also prevents a retry
    // from issuing a second native delete for an id already in flight.
    const retries = retryPendingPostgresCredentialDeletions(entry.id);
    void retries.catch(reportCredentialStorageError);
    return {
      connections: next.map(({ connection }) => connection),
      credentialDeleted: deletePostgresCredential(entry.id),
    };
  }

  let connections: string[];
  try {
    const value = window.localStorage.getItem(POSTGRES_CONNECTIONS_STORAGE_KEY);
    const parsed: unknown = value ? JSON.parse(value) : [];
    if (!Array.isArray(parsed)) {
      throw new Error("The saved PostGIS connection list is malformed.");
    }
    connections = uniquePostgresConnections(
      parsed.filter((item): item is string => typeof item === "string"),
    ).filter((saved) => saved !== connectionString);
    window.localStorage.setItem(POSTGRES_CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
  } catch {
    throw new PostgresConnectionForgetError();
  }
  window.dispatchEvent(new Event(POSTGRES_CONNECTIONS_CHANGED_EVENT));
  return { connections, credentialDeleted: Promise.resolve(true) };
}

export function rememberPostgresConnection(connectionString: string): string[] {
  const trimmed = connectionString.trim();
  if (!trimmed || typeof window === "undefined") return [];

  const connections = uniquePostgresConnections([
    trimmed,
    ...readSavedPostgresConnections().filter((value) => value !== trimmed),
  ]).slice(0, MAX_SAVED_POSTGRES_CONNECTIONS);

  if (credentialStorageLocation() === "keychain") {
    rememberKeychainPostgresConnections(connections);
    return connections;
  }

  try {
    window.localStorage.setItem(POSTGRES_CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
    // Notify same-tab listeners (the Browser panel) so a newly-saved connection
    // appears without closing and reopening the panel.
    window.dispatchEvent(new Event(POSTGRES_CONNECTIONS_CHANGED_EVENT));
  } catch {
    // Best-effort persistence: a quota/private-mode failure must not abort the
    // connect flow (mirrors readBrowserPostgresConnections' guard).
  }
  return connections;
}

/**
 * Desktop write path. Ids are stable per DSN, so reordering the MRU list only
 * rewrites the non-secret index; the credential store sees just the new DSN
 * and any evicted one. The index is written first so a crash cannot leave an
 * unindexed credential behind.
 */
function rememberKeychainPostgresConnections(connections: string[]): void {
  const previous = keychainConnections ?? [];
  const idByConnection = new Map(previous.map(({ id, connection }) => [connection, id]));
  const next = connections.map((connection) => ({
    id: idByConnection.get(connection) ?? crypto.randomUUID(),
    connection,
  }));
  setKeychainPostgresConnections(next);
  if (!postgresKeychainWritable) return;

  try {
    window.localStorage.setItem(
      POSTGRES_CONNECTION_IDS_STORAGE_KEY,
      JSON.stringify(next.map(({ id }) => id)),
    );
  } catch (error) {
    reportCredentialStorageError(error);
    postgresKeychainWritable = false;
    return;
  }
  void queueCredentialChanges(postgresConnectionSecrets(previous), postgresConnectionSecrets(next));
}

/**
 * The saved connections whose masked label is `label`. Several can match:
 * the label hides only the password (e.g. before/after a rotation).
 */
export function savedPostgresConnectionsWithLabel(label: string): string[] {
  return readSavedPostgresConnections().filter(
    (connection) => savedPostgresConnectionLabel(connection) === label,
  );
}

// The password stops at `/`, `?` and `#` (a URI must percent-encode them in
// userinfo), so a port followed by an `@` in the query is not taken for one.
const USERINFO_PASSWORD = /(:\/\/[^:\s/?#@]+:)[^@\s/?#]+@/;

export function savedPostgresConnectionLabel(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    // Chromium (and Android WebView) before 130 parsed non-special schemes
    // like `postgresql:` as an opaque path: no host, and the password stays
    // in the path. Mask the raw string then (also covers `postgres:///db`).
    if (!url.host) {
      return connectionString
        .replace(USERINFO_PASSWORD, "$1****@")
        .replace(/([?&](?:ssl)?password=)[^&#]*/gi, "$1****");
    }
    if (url.password) url.password = "****";
    // libpq URIs also take the password as a query parameter. Only rewrite
    // the query when one is present: re-serializing it can change unrelated
    // escapes, and the label is a lookup key persisted in projects.
    const secretKeys = [...url.searchParams.keys()].filter((key) =>
      /^(password|sslpassword)$/i.test(key),
    );
    for (const key of secretKeys) url.searchParams.set(key, "****");
    return url.toString();
  } catch {
    return connectionString
      .replace(USERINFO_PASSWORD, "$1****@")
      .replace(/(password\s*=\s*)('[^']*'|[^\s]+)/gi, "$1****");
  }
}
