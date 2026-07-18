// Uploads a serialized GeoLibre project to share.geolibre.app via its
// `POST /api/projects` endpoint, authenticated with a personal API token the
// user created on the website. Used by the Project > Share action.

import { DEFAULT_PROJECT_NAME } from "@geolibre/core";
import { getShareFetch } from "./share-fetch";

export type ShareVisibility = "public" | "unlisted" | "private";

/**
 * Machine-readable cause for an upload failure the dialog can react to. Only
 * conditions that warrant dedicated UI (beyond showing the message) get a code.
 * `username-required` means the account has no username yet, which the user must
 * set on the share.geolibre.app website before any upload can succeed.
 */
export type ShareUploadErrorCode = "username-required";

/**
 * Error thrown by {@link uploadProjectToShare}. Carries a human-readable message
 * plus an optional {@link ShareUploadErrorCode} so the dialog can render targeted
 * guidance (e.g. a deep link to account settings) instead of a bare string.
 */
export class ShareUploadError extends Error {
  readonly code?: ShareUploadErrorCode;

  constructor(message: string, code?: ShareUploadErrorCode) {
    super(message);
    // Restore the prototype chain so `instanceof ShareUploadError` holds even if
    // this is ever transpiled to a target where `extends Error` loses it; the
    // dialog's error branching depends on that check.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "ShareUploadError";
    this.code = code;
  }
}

// Sentinel the share server returns (as a plain 400 body) when an authenticated
// account has no username yet. Kept as a named constant so the one coupling
// point to the server's error vocabulary is obvious and easy to update.
const USERNAME_REQUIRED_PATTERN = /username required/i;

export interface ShareUploadResult {
  username: string;
  slug: string;
  projectUrl: string;
  viewerUrl: string;
  rawJsonUrl: string;
}

export interface ShareUploadOptions {
  token: string;
  filename: string;
  content: string;
  visibility: ShareVisibility;
  /** Override the share host; defaults to the configured/production URL. */
  baseUrl?: string;
  signal?: AbortSignal;
  /** Injected for testing; defaults to the share fetch (see share-fetch.ts). */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_SHARE_BASE_URL = "https://share.geolibre.app";

// Upload deadline; a hung connection rejects with a TimeoutError rather than
// spinning forever.
const UPLOAD_TIMEOUT_MS = 30_000;

// The placeholder name a project gets before the user names it, sourced from
// @geolibre/core so the Share guard stays in sync with the save fallback.
// Sharing under this title is unhelpful, so the Share dialog requires a real
// title first.
export const DEFAULT_PROJECT_TITLE = DEFAULT_PROJECT_NAME;

// Upper bound on a project title, shared with the dialog's input so the gate and
// the widget stay in sync. Matches the server's title length limit.
export const MAX_PROJECT_TITLE_LENGTH = 100;

/**
 * A title is shareable when it is non-empty, within the length limit, and not
 * the default placeholder. The length check keeps the predicate self-contained
 * rather than relying on the input's `maxLength` attribute alone.
 */
export function isShareableTitle(title: string): boolean {
  const trimmed = title.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_PROJECT_TITLE_LENGTH &&
    trimmed !== DEFAULT_PROJECT_TITLE
  );
}

/**
 * Resolve the share host from the Vite env, falling back to production. The
 * `configured` value is read from the env by default but can be passed directly
 * in tests.
 */
export function resolveShareBaseUrl(
  configured: unknown = import.meta.env?.VITE_GEOLIBRE_SHARE_URL,
): string {
  if (typeof configured === "string" && configured.trim()) {
    const trimmed = configured.trim().replace(/\/+$/, "");
    // Only accept HTTPS (or HTTP on loopback for local dev) so a misconfigured
    // env var can't send the Bearer token over a plaintext connection. Parse the
    // URL and match the hostname exactly: a prefix check like
    // `startsWith("http://localhost")` would also accept hosts such as
    // `http://localhost.evil.com`.
    try {
      const url = new URL(trimmed);
      if (
        url.protocol === "https:" ||
        (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
      ) {
        return trimmed;
      }
    } catch {
      // Invalid URL; fall through to the production default.
    }
  }
  return DEFAULT_SHARE_BASE_URL;
}

interface ShareProjectResponse {
  project?: {
    username?: string;
    slug?: string;
    projectUrl?: string;
    viewerUrl?: string;
    rawJsonUrl?: string;
  };
}

export async function uploadProjectToShare(
  options: ShareUploadOptions,
): Promise<ShareUploadResult> {
  const token = options.token.trim();
  if (!token) {
    throw new Error("Add a share.geolibre.app API token in Settings before sharing.");
  }

  const base = (options.baseUrl ?? resolveShareBaseUrl()).replace(/\/+$/, "");
  // Defaults to the share fetch, which the desktop build routes through Tauri's
  // native HTTP client to bypass WebView CORS (see share-fetch.ts).
  const fetchImpl = options.fetchImpl ?? getShareFetch();

  // Bound the request so a stalled server can't leave the dialog spinning
  // forever; combine it with the caller's abort signal (dialog close).
  const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/projects`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filename: options.filename,
        content: options.content,
        visibility: options.visibility,
      }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException) {
      // Caller-initiated abort (dialog closed): propagate so the UI ignores it.
      if (error.name === "AbortError") throw error;
      if (error.name === "TimeoutError") {
        throw new Error("Upload timed out. Please try again.");
      }
    }
    throw new Error("Could not reach share.geolibre.app. Check your internet connection.");
  }

  if (!response.ok) {
    const { message, code } = await uploadErrorInfo(response);
    throw new ShareUploadError(message, code);
  }

  const payload = (await response.json().catch(() => ({}))) as ShareProjectResponse;
  const project = payload.project;
  if (!project?.projectUrl || !project.rawJsonUrl) {
    throw new Error("share.geolibre.app returned an unexpected response.");
  }
  return {
    username: project.username ?? "",
    slug: project.slug ?? "",
    projectUrl: project.projectUrl,
    viewerUrl: project.viewerUrl ?? "",
    rawJsonUrl: project.rawJsonUrl,
  };
}

async function uploadErrorInfo(
  response: Response,
): Promise<{ message: string; code?: ShareUploadErrorCode }> {
  if (response.status === 401) {
    return { message: "Invalid or expired API token. Update it in Settings." };
  }
  if (response.status === 403) {
    return { message: "This API token is not allowed to upload projects." };
  }
  if (response.status === 429) {
    return { message: "Too many uploads. Please wait a while and try again." };
  }
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  // Cap the server-provided string so a misconfigured host or MITM on a
  // non-HTTPS share URL cannot render a wall of text in the dialog. Slice by
  // code point so the cap can't orphan a UTF-16 surrogate pair.
  if (typeof body?.error === "string" && body.error.trim()) {
    const message = [...body.error].slice(0, 300).join("");
    // The share server returns this on a generic 400 when the account has no
    // username yet. Flag it so the dialog can point the user at the website's
    // account settings (where usernames are set), not the local app settings.
    // This substring must stay in sync with the server's error text: if the
    // server rephrases or localizes the message, the code falls back to
    // undefined and the dialog shows the raw server string instead.
    const code = USERNAME_REQUIRED_PATTERN.test(message)
      ? ("username-required" as const)
      : undefined;
    return { message, code };
  }
  return { message: `Upload failed (HTTP ${response.status}).` };
}
