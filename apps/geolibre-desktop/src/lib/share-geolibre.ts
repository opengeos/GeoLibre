// Uploads a serialized GeoLibre project to a share server via its
// `POST /api/projects` endpoint, authenticated with a personal API token the
// user created on that server. Used by the Project > Share action.
//
// The host is share.geolibre.app unless the deployment names another one; see
// `resolveShareHost` for the precedence and for why a rejected value disables
// sharing instead of falling back to the hosted service.

import {
  DEFAULT_PROJECT_NAME,
  parseProject,
  redactCredentials,
  serializeProject,
} from "@geolibre/core";
import { readDeploymentEnvValue, type EnvRecord } from "./deployment-env";
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
 * Deployment variable naming the share host. Settable at build time or, on a
 * prebuilt Docker image, with `-e GEOLIBRE_SHARE_URL=…` (the entrypoint copies it
 * into the runtime config under this name).
 */
export const SHARE_URL_ENV = "VITE_GEOLIBRE_SHARE_URL";

/** Value of {@link SHARE_URL_ENV} that turns project sharing off entirely. */
export const SHARE_DISABLED_VALUE = "off";

/**
 * Why the share host is (or is not) what it is.
 *
 * - `default` — nothing configured, so the hosted service applies.
 * - `configured` — a deployment named a host and it was accepted.
 * - `disabled` — the deployment set {@link SHARE_DISABLED_VALUE}.
 * - `invalid` — a deployment named a host and it was **rejected**. Sharing is
 *   unavailable; it deliberately does not degrade to the hosted service.
 */
export type ShareHostStatus = "default" | "configured" | "disabled" | "invalid";

export interface ShareHost {
  status: ShareHostStatus;
  /** Host to talk to, or null when sharing is unavailable. */
  baseUrl: string | null;
  /** The configured value, kept for the `invalid` message. Null when unset. */
  configured: string | null;
}

/**
 * Whether a URL is safe to send a Bearer token to: HTTPS anywhere, or HTTP on
 * loopback for local development, and never with credentials in the URL.
 *
 * The hostname is matched exactly rather than by prefix — `startsWith(
 * "http://localhost")` would also accept `http://localhost.evil.com`. A
 * self-hosted server on a private network therefore needs TLS; see
 * `docs/getting-started.md`.
 *
 * Embedded credentials are rejected regardless of scheme, mirroring the
 * `service_url()` validator in `docker/entrypoint.sh`: a `https://user:pass@host`
 * base would send Basic Auth alongside the Bearer token on every request, and
 * the value reaches log output and error messages.
 */
function isSafeShareUrl(url: URL): boolean {
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/**
 * Resolve the share host, preferring the deployment env over the build env.
 *
 * A configured-but-rejected value resolves to `invalid` with a null `baseUrl`
 * rather than falling back to {@link DEFAULT_SHARE_BASE_URL}. That fallback used
 * to mean a self-hosted deployment with a typo'd or plaintext host silently
 * uploaded its users' projects to the public hosted service — the one outcome a
 * private deployment must never produce. The hosted default now applies only
 * when nothing is configured at all.
 *
 * @param configured - The raw value; read from the env when omitted.
 * @param deploymentEnv - Runtime env override, for tests.
 * @returns The resolved host and why.
 */
export function resolveShareHost(configured?: unknown, deploymentEnv?: EnvRecord): ShareHost {
  const raw =
    configured !== undefined ? configured : readDeploymentEnvValue(SHARE_URL_ENV, deploymentEnv);
  if (typeof raw !== "string" || !raw.trim()) {
    return { status: "default", baseUrl: DEFAULT_SHARE_BASE_URL, configured: null };
  }
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.toLowerCase() === SHARE_DISABLED_VALUE) {
    return { status: "disabled", baseUrl: null, configured: trimmed };
  }
  try {
    const url = new URL(trimmed);
    if (isSafeShareUrl(url)) {
      return { status: "configured", baseUrl: trimmed, configured: trimmed };
    }
  } catch {
    // Unparseable; falls through to `invalid` below.
  }
  return { status: "invalid", baseUrl: null, configured: trimmed };
}

/**
 * The share host to talk to, or null when sharing is unavailable.
 *
 * Callers that need to explain *why* it is unavailable should use
 * {@link resolveShareHost} instead.
 */
export function resolveShareBaseUrl(configured?: unknown): string | null {
  return resolveShareHost(configured).baseUrl;
}

/**
 * A base URL's host, plus its path when it has one, falling back to the hosted
 * default's host when unparseable.
 *
 * The path is kept so a server hosted under a subpath
 * (`https://example.test/geolibre`) is named the way the links built from the
 * same base URL resolve — dropping it would show `example.test` next to a link to
 * `https://example.test/geolibre/settings`.
 */
function hostOf(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, "");
    return path ? `${url.host}${path}` : url.host;
  } catch {
    return new URL(DEFAULT_SHARE_BASE_URL).host;
  }
}

/**
 * Hostname to name in UI copy — the `{{shareHost}}` interpolation in the message
 * catalogues ("Sign in to {{shareHost}}") — so a self-hosted deployment reads its
 * own host instead of share.geolibre.app.
 *
 * Falls back to the hosted default's hostname when no usable host is configured.
 * Callers must not render host-bearing copy in that state — see
 * `shareHostStatus`; the fallback exists so this never returns an empty string,
 * not as a licence to advertise the hosted service on a deployment that opted
 * out.
 */
export function shareHostLabel(): string {
  return hostOf(resolveShareBaseUrl() ?? DEFAULT_SHARE_BASE_URL);
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
    throw new Error("Add a share API token in Settings before sharing.");
  }

  // Null means the deployment disabled sharing or named a host that was
  // rejected. The dialog gates on the same state, so reaching here is a bug
  // rather than something a user can do — fail loudly instead of falling back to
  // the hosted service with the user's project.
  const resolved = options.baseUrl ?? resolveShareBaseUrl();
  if (!resolved) {
    throw new Error("No share server is configured for this deployment.");
  }
  const base = resolved.replace(/\/+$/, "");
  // Named in the failure messages below so a self-hosted deployment does not
  // report an outage at share.geolibre.app.
  const hostLabel = hostOf(base);
  // Defaults to the share fetch, which the desktop build routes through Tauri's
  // native HTTP client to bypass WebView CORS (see share-fetch.ts).
  const fetchImpl = options.fetchImpl ?? getShareFetch();

  // Bound the request so a stalled server can't leave the dialog spinning
  // forever; combine it with the caller's abort signal (dialog close).
  const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let safeContent: string;
  try {
    safeContent = serializeProject(redactCredentials(parseProject(options.content)));
  } catch {
    throw new Error("The project could not be validated before sharing.");
  }

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
        content: safeContent,
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
    throw new Error(`Could not reach ${hostLabel}. Check your internet connection.`);
  }

  if (!response.ok) {
    const { message, code } = await uploadErrorInfo(response);
    throw new ShareUploadError(message, code);
  }

  const payload = (await response.json().catch(() => ({}))) as ShareProjectResponse;
  const project = payload.project;
  if (!project?.projectUrl || !project.rawJsonUrl) {
    throw new Error(`${hostLabel} returned an unexpected response.`);
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
