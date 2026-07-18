/**
 * Shared logic for checking GeoLibre releases on GitHub. Used by both the
 * manual "Check for updates" flow in the About dialog and the automated
 * startup check (desktop only). Keeping the version math and the GitHub fetch
 * here means the two surfaces classify and compare releases identically.
 */

/** Page that lists cross-platform installers. */
export const UPDATE_URL = "https://geolibre.app/downloads/";

/** GitHub REST endpoint for the latest published release. */
export const LATEST_RELEASE_URL = "https://api.github.com/repos/opengeos/GeoLibre/releases/latest";

/**
 * The running app version, injected by Vite at build time. Guarded so the pure
 * helpers below can be imported in a plain Node test (where the define is
 * absent) without throwing a ReferenceError.
 */
export const APP_VERSION: string =
  typeof __GEOLIBRE_VERSION__ !== "undefined" ? __GEOLIBRE_VERSION__ : "0.0.0";

/**
 * True in the Microsoft Store MSIX build, where the entire in-app update flow is
 * removed so the app updates only through the Store (Microsoft policy 10.2.5
 * rejects a Store app that updates itself outside the Store). Guarded the same
 * way as {@link APP_VERSION} so the pure helpers here stay importable in a plain
 * Node test (where the define is absent) without throwing a ReferenceError.
 * Injected by vite.config.ts; set only by the Store build (msix-store.yml).
 */
export const IS_STORE_BUILD: boolean =
  typeof __GEOLIBRE_STORE_BUILD__ !== "undefined" ? __GEOLIBRE_STORE_BUILD__ : false;

/**
 * How a newer release differs from the running version. Used to filter startup
 * notifications by the user's chosen granularity (see {@link UpdateNotificationLevel}).
 */
export type ReleaseSeverity = "major" | "minor" | "patch";

/**
 * Which releases should trigger an automated startup notification:
 * - `all`: major, minor, and patch builds
 * - `minor`: major and minor builds only
 * - `major`: major builds only
 */
export type UpdateNotificationLevel = "all" | "minor" | "major";

/** A normalized view of the latest GitHub release. */
export interface LatestRelease {
  /** Formatted version tag, e.g. `"v1.6.0"`. */
  version: string;
  /** Raw release-notes body (Markdown). May be an empty string. */
  notes: string;
  /** The release page URL, falling back to the downloads page. */
  url: string;
}

/** Stable error codes for a failed update check, resolved to i18n at call sites. */
export type UpdateCheckErrorCode = "rateLimit" | "http" | "noTag" | "network";

/** Error thrown by {@link fetchLatestRelease} for a non-abort failure. */
export class UpdateCheckError extends Error {
  readonly code: UpdateCheckErrorCode;
  readonly status?: number;

  constructor(code: UpdateCheckErrorCode, status?: number) {
    super(code);
    this.name = "UpdateCheckError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Parse a `vX.Y.Z` (or `X.Y.Z`) version into its numeric components.
 *
 * @param version - A semantic version string, optionally prefixed with `v`.
 * @returns A `[major, minor, patch]` tuple, or `null` if it does not match.
 */
export function parseVersion(version: string): [number, number, number] | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compare two version strings numerically.
 *
 * @returns A negative number if `currentVersion` is older than `latestVersion`,
 *   positive if newer, and `0` if equal or either is unparseable.
 */
export function compareVersions(currentVersion: string, latestVersion: string): number {
  const current = parseVersion(currentVersion);
  const latest = parseVersion(latestVersion);
  if (!current || !latest) return 0;

  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== latest[index]) return current[index] - latest[index];
  }

  return 0;
}

/**
 * Ensure a version string carries the leading `v` used throughout the UI.
 */
export function formatVersion(version: string): string {
  const trimmedVersion = version.trim();
  return trimmedVersion.startsWith("v") ? trimmedVersion : `v${trimmedVersion}`;
}

/**
 * Classify how `latestVersion` differs from `currentVersion`.
 *
 * @returns `"major"`, `"minor"`, or `"patch"` when `latestVersion` is newer,
 *   or `null` when it is not newer or either version is unparseable.
 */
export function releaseSeverity(
  currentVersion: string,
  latestVersion: string,
): ReleaseSeverity | null {
  const current = parseVersion(currentVersion);
  const latest = parseVersion(latestVersion);
  if (!current || !latest) return null;

  if (latest[0] > current[0]) return "major";
  if (latest[0] < current[0]) return null;
  if (latest[1] > current[1]) return "minor";
  if (latest[1] < current[1]) return null;
  if (latest[2] > current[2]) return "patch";
  return null;
}

/**
 * Whether a release of the given `severity` should raise a startup
 * notification under the user's chosen `level`.
 */
export function meetsNotificationLevel(
  severity: ReleaseSeverity,
  level: UpdateNotificationLevel,
): boolean {
  if (level === "all") return true;
  if (level === "minor") return severity === "major" || severity === "minor";
  return severity === "major";
}

interface GitHubRelease {
  tag_name?: unknown;
  body?: unknown;
  html_url?: unknown;
}

/**
 * Fetch the latest GeoLibre release from GitHub.
 *
 * @param signal - Optional abort signal to cancel the request.
 * @returns The normalized latest release.
 * @throws {UpdateCheckError} On rate limiting, an HTTP error, a missing tag, or
 *   a network failure. An `AbortError` propagates unchanged so callers can
 *   ignore intentional cancellations.
 */
export async function fetchLatestRelease(signal?: AbortSignal): Promise<LatestRelease> {
  let response: Response;
  try {
    response = await fetch(LATEST_RELEASE_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal,
    });
  } catch (error) {
    // Let intentional cancellations bubble up so callers can ignore them.
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new UpdateCheckError("network");
  }

  if (!response.ok) {
    // GitHub signals its primary rate limit with 403 + exhausted remaining, and
    // its secondary rate limit with 429; map both to the actionable message.
    if (
      (response.status === 403 && response.headers.get("X-RateLimit-Remaining") === "0") ||
      response.status === 429
    ) {
      throw new UpdateCheckError("rateLimit", response.status);
    }
    throw new UpdateCheckError("http", response.status);
  }

  let release: GitHubRelease;
  try {
    release = (await response.json()) as GitHubRelease;
  } catch {
    // A malformed 200 body would otherwise throw a plain SyntaxError that
    // bypasses UpdateCheckError; treat it like any other failed fetch.
    throw new UpdateCheckError("network");
  }
  if (typeof release.tag_name !== "string" || !release.tag_name.trim()) {
    throw new UpdateCheckError("noTag");
  }

  const htmlUrl = typeof release.html_url === "string" ? release.html_url.trim() : "";
  return {
    version: formatVersion(release.tag_name),
    // Cap the notes length; GitHub enforces no size limit on release bodies and
    // 50k is generous for any real changelog while ruling out pathological blobs.
    notes: typeof release.body === "string" ? release.body.trim().slice(0, 50_000) : "",
    // Only trust a GitHub release URL; fall back to the downloads page so a
    // tampered API response can't redirect the download action to another
    // origin (openExternalLink already blocks non-http(s) schemes).
    url: /^https:\/\/github\.com\//i.test(htmlUrl) ? htmlUrl : UPDATE_URL,
  };
}
