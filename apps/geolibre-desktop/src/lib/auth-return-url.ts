// Carries a deep link's query parameters across a sign-in redirect.
//
// The Auth0 gate sends the visitor to the tenant's hosted login page and Auth0
// returns them to one registered callback URL, so everything after the `?` is
// gone on the load that follows. `Auth0Gate`'s `onRedirectCallback` puts the
// original URL back, but that runs inside a React effect — too late for the two
// settings the app resolves *synchronously while booting*, before any component
// mounts: the UI language (`getInitialLanguage()`, called at module scope during
// `import "./i18n"`) and the theme (`getInitialThemeMode()`). Without this, a
// visitor arriving at `?theme=dark&locale=fr` on a gated deployment gets their
// OS theme and persisted language on the first paint after signing in, and their
// actual choice only on the next reload.
//
// So the query is stashed before the redirect leaves and merged back in on the
// callback load, ahead of those reads. Only the query and hash are stored, never
// a URL: nothing here can send the visitor anywhere.

/** sessionStorage key holding the query+hash a sign-in redirect is about to lose. */
const STASH_KEY = "geolibre.auth.returnQuery";

/**
 * The parameters Auth0 appends to the callback URL, which belong to one attempt.
 *
 * They must never be carried into the next one. A refused login leaves `error`
 * in the address bar — auth0-react only cleans the URL after a callback it
 * *accepted*, so the error screen keeps them — and stashing that URL for the
 * retry would put `error` back on the next, successful callback, where the SDK
 * rejects the whole login. That is a permanent lockout: every retry re-arms it.
 */
export const CALLBACK_PARAMS = ["code", "state", "error", "error_description"] as const;

/**
 * Drop Auth0's callback parameters from a query string.
 *
 * @param search - A query string, with or without its leading `?`.
 * @returns A `?`-prefixed query string, or `""` when nothing is left.
 */
export function stripCallbackParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of CALLBACK_PARAMS) params.delete(key);
  const remaining = params.toString();
  return remaining ? `?${remaining}` : "";
}

/**
 * Merge stashed query parameters into the callback URL's own.
 *
 * The callback's parameters win, so the single-use `code`/`state` Auth0 appended
 * are never shadowed by a stale stash. A key the callback does not carry is
 * restored with *all* of its values, so a repeated parameter survives intact.
 *
 * @param currentSearch - `location.search` of the callback URL.
 * @param stashedSearch - The query string saved before the redirect.
 * @returns A `?`-prefixed query string, or `""` when the result is empty.
 */
export function mergeStashedQuery(currentSearch: string, stashedSearch: string): string {
  const current = new URLSearchParams(currentSearch);
  const stashed = new URLSearchParams(stashedSearch);
  for (const key of new Set(stashed.keys())) {
    if (current.has(key)) continue;
    for (const value of stashed.getAll(key)) current.append(key, value);
  }
  const merged = current.toString();
  return merged ? `?${merged}` : "";
}

/**
 * Remember the current query and hash before a sign-in redirect leaves the page.
 *
 * Only the app's own parameters are kept: signing in again from the error screen
 * would otherwise stash that screen's `error`, and hand it to the next attempt.
 * See {@link CALLBACK_PARAMS}.
 *
 * A no-op when sessionStorage is unavailable (private-mode restrictions, storage
 * disabled): the deep link is then lost on the round trip exactly as it was
 * before, which is a cosmetic loss and never a reason to block signing in.
 */
export function stashAuthReturnQuery(): void {
  try {
    const search = stripCallbackParams(window.location.search);
    sessionStorage.setItem(STASH_KEY, search + window.location.hash);
  } catch {
    // Storage blocked — see above.
  }
}

/**
 * Whether a query string is Auth0 returning from a login attempt.
 *
 * `state` is Auth0's CSRF token and rides on every return, successful or not.
 * What follows it differs: `code` on success, `error`/`error_description` when
 * the tenant refused — an Action calling `api.access.deny()`, a rejected
 * consent. Both are returns from the redirect this module compensates for, and
 * the refusal is if anything the more important one to cover: it is the screen
 * that has something to say, so it is the screen that most needs the visitor's
 * own language.
 *
 * @param search - `location.search` of the current load.
 */
export function isSignInCallback(search: string): boolean {
  const params = new URLSearchParams(search);
  if (!params.has("state")) return false;
  return params.has("code") || params.has("error");
}

/**
 * Put a stashed deep link back, if this load is a sign-in callback.
 *
 * Must run before anything reads `location.search` for a startup setting — see
 * the note on its import in `main.tsx`. Consumes the stash either way, so a
 * stale entry cannot leak into an unrelated later navigation.
 */
export function restoreAuthReturnQuery(): void {
  let stashed: string | null = null;
  try {
    stashed = sessionStorage.getItem(STASH_KEY);
    if (stashed !== null) sessionStorage.removeItem(STASH_KEY);
  } catch {
    return;
  }
  if (!stashed) return;
  // Only a return from Auth0 gets its query rewritten. Any other load reaching a
  // leftover stash (a new tab, an abandoned login) keeps its own URL.
  if (!isSignInCallback(window.location.search)) return;
  const hashAt = stashed.indexOf("#");
  const stashedSearch = hashAt === -1 ? stashed : stashed.slice(0, hashAt);
  const stashedHash = hashAt === -1 ? "" : stashed.slice(hashAt);
  const search = mergeStashedQuery(window.location.search, stashedSearch);
  const hash = window.location.hash || stashedHash;
  window.history.replaceState({}, "", `${window.location.pathname}${search}${hash}`);
}
