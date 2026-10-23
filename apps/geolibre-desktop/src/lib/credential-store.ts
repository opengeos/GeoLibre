/**
 * Where saved credentials live (issue #1667). The desktop (Tauri) build keeps
 * them in the OS credential store through the `secure_store_*` commands in
 * `src-tauri/src/secure_store.rs`, one entry per credential. The web build, the
 * Jupyter embed and the mobile apps keep them in localStorage.
 *
 * Failures never fall back to plaintext: they are reported through
 * {@link useCredentialStorageStatus}, which drives the shell banner and the
 * Settings notice, and the affected values live only in memory this session.
 */
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { isDesktopRuntime } from "./is-mobile";

export type CredentialStorageLocation = "keychain" | "browser";

export function credentialStorageLocation(): CredentialStorageLocation {
  return isDesktopRuntime() ? "keychain" : "browser";
}

/** Whether this document has used or closed its one credential read. */
let readsSealed = false;

/**
 * Reads the given accounts; accounts with no entry are omitted from the result.
 *
 * The desktop store answers this once per page load (issue #2858): startup
 * hydration makes the single read, and every later read fails, because
 * external plugins share this webview and could otherwise read any saved
 * token. The read is used up even when it fails.
 */
export async function readSecureCredentials(
  accounts: readonly string[],
): Promise<Record<string, string>> {
  // Only a read that succeeded is known to have claimed the store's gate. A
  // failed call may never have reached the command (an IPC error), so it
  // leaves {@link sealSecureCredentialReads} to close reads explicitly; the
  // seal is idempotent on the Rust side.
  const read = await invoke<Record<string, string>>("secure_store_get_many", {
    accounts: [...accounts],
  });
  readsSealed = true;
  return read;
}

/**
 * Closes credential reads for this page load without reading, so a plugin
 * imported afterwards cannot read saved tokens even if startup hydration never
 * made its read. A no-op outside the desktop build, which has no credential
 * store, and after the read was made or closed. Rejects when the store could
 * not be closed, so the caller can refuse to load untrusted code.
 */
export async function sealSecureCredentialReads(): Promise<void> {
  if (readsSealed || credentialStorageLocation() !== "keychain") return;
  await invoke("secure_store_seal");
  readsSealed = true;
}

const MAX_ACCOUNT_BYTES = 512;

/**
 * Whether the credential store accepts `account` (same rules as
 * `validate_account` in `secure_store.rs`). Names come from user-typed
 * variable names and project-file layer IDs, so they are checked before they
 * reach an account index: one rejected name there would fail every later read.
 */
export function isStorableCredentialAccount(account: string): boolean {
  return (
    account.length > 0 &&
    new TextEncoder().encode(account).length <= MAX_ACCOUNT_BYTES &&
    !/\p{Cc}/u.test(account)
  );
}

/** Stores `value` under `account`; an empty value deletes the entry. */
export async function writeSecureCredential(account: string, value: string): Promise<void> {
  if (value === "") {
    await invoke("secure_store_delete", { account });
  } else {
    await invoke("secure_store_set", { account, secret: value });
  }
}

interface CredentialStorageStatus {
  /**
   * The latest secure-storage failure, or null. Cleared once every failed
   * queued write has been retried successfully, unless {@link lasting}.
   */
  error: string | null;
  /**
   * Whether a failure that no later write fixes was reported this session: a
   * failed startup read leaves credentials session-only until the app closes,
   * and a failed localStorage write can leave plaintext behind.
   */
  lasting: boolean;
  /** Incremented on every failure so a dismissed warning re-appears. */
  revision: number;
  /**
   * Accounts whose latest queued write failed and is still waiting for a
   * retry. An entry is removed once a retry succeeds, so it tells whether one
   * credential is persisted right now.
   */
  failedAccounts: Readonly<Record<string, true>>;
}

export const useCredentialStorageStatus = create<CredentialStorageStatus>(() => ({
  error: null,
  lasting: false,
  revision: 0,
  failedAccounts: {},
}));

/** Reports a failure that a later write does not fix; the warning stays for the session. */
export function reportCredentialStorageError(error: unknown): void {
  recordFailure(error, true);
}

function recordFailure(error: unknown, lasting: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  useCredentialStorageStatus.setState((state) => ({
    error: message,
    lasting: state.lasting || lasting,
    revision: state.revision + 1,
  }));
  console.error("[GeoLibre] Secure credential storage failed", error);
}

/** Account → latest value not yet written; "" means delete. */
const pending = new Map<string, string>();
let drain: Promise<void> = Promise.resolve();

function markAccountFailure(account: string, error: unknown): void {
  useCredentialStorageStatus.setState((state) => ({
    failedAccounts: { ...state.failedAccounts, [account]: true },
  }));
  recordFailure(error, false);
}

function clearAccountFailure(account: string): void {
  if (!useCredentialStorageStatus.getState().failedAccounts[account]) return;
  useCredentialStorageStatus.setState((state) => {
    const failedAccounts = { ...state.failedAccounts };
    delete failedAccounts[account];
    // Every failed write is stored now; the warning would be out of date.
    const recovered = !state.lasting && Object.keys(failedAccounts).length === 0;
    return recovered ? { failedAccounts, error: null } : { failedAccounts };
  });
}

async function drainPending(): Promise<void> {
  for (const [account, value] of [...pending]) {
    try {
      await writeSecureCredential(account, value);
    } catch (error) {
      // Accounts are independent, so one failure must not stop later writes.
      markAccountFailure(account, error);
      continue;
    }
    // A newer value queued while this write was in flight stays pending.
    if (pending.get(account) !== value) continue;
    pending.delete(account);
    clearAccountFailure(account);
  }
}

/** Whether a queued write for `account` has not completed yet (in flight or failed). */
export function hasPendingCredential(account: string): boolean {
  return pending.has(account);
}

/**
 * Queues a write for every account whose value differs between `previous` and
 * `next` (missing or empty means delete), then writes all pending accounts in
 * order. Accounts that failed earlier are retried on every call, even one that
 * contributes no change. The returned promise never rejects.
 */
export function queueCredentialChanges(
  previous: Readonly<Record<string, string>>,
  next: Readonly<Record<string, string>>,
): Promise<void> {
  for (const account of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const value = next[account] ?? "";
    if ((previous[account] ?? "") !== value) pending.set(account, value);
  }
  drain = drain.then(drainPending);
  return drain;
}

/**
 * Deletes `account` after every queued write ahead of it, dropping any queued
 * write for it so a pending save cannot recreate the entry. Unlike
 * queueCredentialChanges, rejects when the store does not confirm the
 * deletion; the failure is reported through useCredentialStorageStatus but not
 * retried here, so callers keep their own durable retry record.
 */
export function deleteSecureCredentialAfterQueue(account: string): Promise<void> {
  pending.delete(account);
  const deletion = drain.then(() => writeSecureCredential(account, ""));
  drain = deletion.then(
    () => clearAccountFailure(account),
    (error: unknown) => markAccountFailure(account, error),
  );
  return deletion;
}
