/**
 * Host side of `app.credentials` (issue #2729): the tokens and API keys a plugin
 * saves for itself. The desktop (Tauri) build keeps each value as its own OS
 * credential-store entry, `plugin.<pluginId>.<name>`; the web build, the Jupyter
 * embed and the mobile apps keep them in localStorage.
 *
 * Plugins read synchronously, so `credential-hydration.ts` loads every indexed
 * value into memory from its single startup keychain read. The credential store
 * cannot be enumerated, so the accounts that have an entry are indexed in
 * localStorage (non-secret). As with project credentials, the index is written
 * before the credential so a crash cannot leave an unindexed entry behind, and
 * a malformed index fails hydration rather than being partially read. The
 * built-in plugins' pre-#2729 keys are migrated here: on desktop during startup
 * hydration, on the web on first read.
 *
 * The plugin id is injected by `PluginManager`'s scoped app; a plugin passes
 * only `name`. Failures never fall back to plaintext on desktop: the value
 * stays in memory for the session and the credential-storage warning shows.
 */
import type { GeoLibreCredentialLocation } from "@geolibre/plugins";
import {
  credentialStorageLocation,
  hasPendingCredential,
  isStorableCredentialAccount,
  queueCredentialChanges,
  reportCredentialStorageError,
  useCredentialStorageStatus,
  writeSecureCredential,
} from "./credential-store";

/** Desktop: non-secret JSON array of accounts that have a stored value. */
export const PLUGIN_CREDENTIAL_ACCOUNTS_STORAGE_KEY = "geolibre.pluginCredentials.accounts";
/** Web/embed/mobile: the localStorage key is `${prefix}${pluginId}.${name}`. */
export const PLUGIN_CREDENTIAL_BROWSER_KEY_PREFIX = "geolibre.pluginCredential.";

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Plaintext localStorage keys the built-in plugins used before app.credentials (issue #2729), by account. */
const LEGACY_PLUGIN_CREDENTIAL_KEYS: Readonly<Record<string, string>> = {
  "plugin.maplibre-gl-huggingface.token": "geolibre:huggingface-token",
  "plugin.maplibre-gl-mapillary.access-token": "geolibre:mapillary-access-token",
  "plugin.gods-eye-view.tomtom": "geolibre.godsEyeView.apiKey.tomtom",
  "plugin.gods-eye-view.aisstream": "geolibre.godsEyeView.apiKey.aisstream",
};

function readLegacyPluginCredentials(): Record<string, { key: string; value: string }> {
  const found: Record<string, { key: string; value: string }> = {};
  for (const [account, key] of Object.entries(LEGACY_PLUGIN_CREDENTIAL_KEYS)) {
    try {
      const value = window.localStorage.getItem(key)?.trim();
      if (value) found[account] = { key, value };
    } catch {
      // Unreadable: nothing to migrate for this entry.
    }
  }
  return found;
}

/** Names cannot contain ".", so the last segment of an account is unambiguous. */
export function pluginCredentialAccount(pluginId: string, name: string): string {
  return `plugin.${pluginId}.${name}`;
}

/** Desktop: account → stored value, for this session. */
let values: Record<string, string> = {};
/** Desktop: account → value last handed to the keychain write queue. */
let persisted: Record<string, string> = {};
/** Desktop: false until hydration succeeds; edits then stay in memory. */
let writable = false;
/** Web: values whose localStorage write failed, kept for this session. */
const sessionOverrides = new Map<string, string>();

/**
 * Reads the desktop account index. Throws on unreadable storage or a malformed
 * index rather than returning a partial list, which would orphan entries.
 */
export function readPluginCredentialIndex(): string[] {
  const value = window.localStorage.getItem(PLUGIN_CREDENTIAL_ACCOUNTS_STORAGE_KEY);
  if (value === null) return [];
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    new Set(parsed).size !== parsed.length ||
    !parsed.every(
      (account) =>
        typeof account === "string" &&
        account.startsWith("plugin.") &&
        isStorableCredentialAccount(account),
    )
  ) {
    throw new Error("The saved plugin credential index is malformed.");
  }
  return parsed as string[];
}

/**
 * Loads the indexed plugin credentials from the startup keychain read, and
 * moves the built-in plugins' pre-#2729 localStorage values into the keychain.
 * `index` or `stored` is `null` when reading it failed (the caller reported
 * it): plugin credentials then stay in memory for the session, and legacy
 * values stay where they are.
 */
export async function hydratePluginCredentials(
  index: readonly string[] | null,
  stored: Readonly<Record<string, string>> | null,
): Promise<void> {
  if (credentialStorageLocation() !== "keychain") return;
  const legacy = readLegacyPluginCredentials();
  if (index === null || stored === null) {
    values = Object.fromEntries(
      Object.entries(legacy).map(([account, { value }]) => [account, value]),
    );
    persisted = {};
    writable = false;
    return;
  }
  const present = index.filter((account) => stored[account] !== undefined);
  values = Object.fromEntries(present.map((account) => [account, stored[account]]));
  // Legacy wins over the keychain: it is what the user last saw (same rule as Settings).
  for (const [account, { value }] of Object.entries(legacy)) values[account] = value;
  const nextIndex = [...new Set([...present, ...Object.keys(legacy)])];
  try {
    // Index first, so a crash cannot leave an unindexed keychain entry. This
    // also drops an indexed write that never landed (crash, failed write).
    if (nextIndex.length !== index.length || nextIndex.some((account, i) => account !== index[i])) {
      window.localStorage.setItem(
        PLUGIN_CREDENTIAL_ACCOUNTS_STORAGE_KEY,
        JSON.stringify(nextIndex),
      );
    }
    for (const [account, { key, value }] of Object.entries(legacy)) {
      if (stored[account] !== value) await writeSecureCredential(account, value);
      window.localStorage.removeItem(key);
    }
  } catch (error) {
    reportCredentialStorageError(error);
    writable = false;
    return;
  }
  persisted = { ...values };
  writable = true;
}

/**
 * Checks the host-call arguments and returns the desktop account. Throws when
 * the owner is missing (the call bypassed the plugin-scoped app) or the name
 * is invalid.
 */
function validate(name: string, ownerPluginId: string | undefined): string {
  if (typeof ownerPluginId !== "string" || ownerPluginId === "") {
    throw new Error("app.credentials must be called through the app API a plugin receives.");
  }
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new TypeError("Credential names must be 1-64 letters, digits, underscores or hyphens.");
  }
  return pluginCredentialAccount(ownerPluginId, name);
}

/** The web localStorage key for one plugin's credential. */
function browserKey(ownerPluginId: string, name: string): string {
  return `${PLUGIN_CREDENTIAL_BROWSER_KEY_PREFIX}${ownerPluginId}.${name}`;
}

/** Desktop read: the in-memory value, "" when none. */
function getDesktop(account: string): string {
  return values[account] ?? "";
}

/**
 * Desktop write. Memory changes first so the session keeps working, but
 * `persisted` only advances once a change has been handed to the write queue,
 * so repeating a request after an index or keychain failure retries it
 * instead of reporting success. Adds are index-first (a crash never leaves an
 * unindexed secret); deletes drop the index entry only after the keychain
 * delete succeeded (a failed delete is never forgotten across a restart).
 * Returns false while the account has an unrecovered failed keychain write.
 */
function setDesktop(account: string, value: string): boolean {
  if (value === "") delete values[account];
  else values[account] = value;
  if (!writable || !isStorableCredentialAccount(account)) return false;
  if (value) {
    try {
      const index = new Set(readPluginCredentialIndex());
      index.add(account);
      window.localStorage.setItem(
        PLUGIN_CREDENTIAL_ACCOUNTS_STORAGE_KEY,
        JSON.stringify([...index]),
      );
    } catch (error) {
      reportCredentialStorageError(error);
      return false;
    }
  }
  const failedBefore = useCredentialStorageStatus.getState().failedAccounts[account] === true;
  const previous = persisted[account] ?? "";
  if (value) persisted[account] = value;
  else delete persisted[account];
  const drained = queueCredentialChanges({ [account]: previous }, { [account]: value });
  if (!value) {
    void drained.then(() => {
      // A newer value, or a delete that has not landed, keeps the entry.
      if (account in values || hasPendingCredential(account)) return;
      try {
        const index = readPluginCredentialIndex().filter((entry) => entry !== account);
        window.localStorage.setItem(PLUGIN_CREDENTIAL_ACCOUNTS_STORAGE_KEY, JSON.stringify(index));
      } catch (error) {
        reportCredentialStorageError(error);
      }
    });
  }
  return !failedBefore;
}

function getBrowser(account: string, key: string): string {
  const override = sessionOverrides.get(account);
  if (override !== undefined) return override;
  try {
    return window.localStorage.getItem(key) ?? migrateLegacyBrowserCredential(account, key);
  } catch {
    return "";
  }
}

/** Web: moves a built-in plugin's pre-#2729 key to its app.credentials key on first read. */
function migrateLegacyBrowserCredential(account: string, key: string): string {
  const legacyKey = LEGACY_PLUGIN_CREDENTIAL_KEYS[account];
  if (!legacyKey) return "";
  const value = window.localStorage.getItem(legacyKey)?.trim() ?? "";
  if (!value) return "";
  try {
    window.localStorage.setItem(key, value);
    window.localStorage.removeItem(legacyKey);
  } catch {
    // Write failed: the legacy key stays and the next read retries.
  }
  return value;
}

function setBrowser(account: string, key: string, value: string): boolean {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    sessionOverrides.set(account, value);
    return false;
  }
  // A cleared or replaced token must not resurface from its pre-#2729 key.
  const legacyKey = LEGACY_PLUGIN_CREDENTIAL_KEYS[account];
  if (legacyKey) {
    try {
      window.localStorage.removeItem(legacyKey);
    } catch {
      // Cleanup failed: without the override a later read would migrate the
      // legacy value back over a cleared or replaced token.
      sessionOverrides.set(account, value);
      return false;
    }
  }
  sessionOverrides.delete(account);
  return true;
}

/**
 * The concrete `app.credentials`. `PluginManager` wraps it per plugin and
 * supplies `ownerPluginId`; the parameter is optional only so the object stays
 * assignable to `GeoLibrePluginCredentials`.
 */
export const pluginCredentialHost: {
  get(name: string, ownerPluginId?: string): string;
  set(name: string, value: string, ownerPluginId?: string): boolean;
  location(): GeoLibreCredentialLocation;
} = {
  get: (name, ownerPluginId) => {
    const account = validate(name, ownerPluginId);
    return credentialStorageLocation() === "keychain"
      ? getDesktop(account)
      : getBrowser(account, browserKey(ownerPluginId as string, name));
  },
  set: (name, value, ownerPluginId) => {
    const account = validate(name, ownerPluginId);
    if (typeof value !== "string") throw new TypeError("Credential values must be strings.");
    return credentialStorageLocation() === "keychain"
      ? setDesktop(account, value)
      : setBrowser(account, browserKey(ownerPluginId as string, name), value);
  },
  location: (): GeoLibreCredentialLocation => credentialStorageLocation(),
};
