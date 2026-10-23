// Lists publicly shared projects from share.geolibre.app's `GET /api/projects`
// endpoint so the Project Gallery can browse and open them. This is the read
// counterpart to share-geolibre.ts (which uploads via `POST /api/projects`).
//
// `fetchSharedProjects` reads the public listing (`GET /api/projects`, no
// token) with `limit` + `offset` pagination. `fetchMyProjects` authenticates
// with an OAuth access token or personal API token to also return the signed-in
// user's `unlisted` and `private` projects.

import { getShareFetch } from "./share-fetch";
import { resolveShareBaseUrl } from "./share-geolibre";

/**
 * Machine-readable cause for a gallery fetch failure. This module is a non-React
 * library and cannot call `t()`, so it throws a coded error and lets the UI
 * layer translate it (per the i18n rule in CLAUDE.md).
 */
export type GalleryErrorCode =
  | "timeout"
  | "network"
  | "http"
  | "invalid-response"
  | "unauthorized"
  | "username-required"
  /** The destination namespace already uses the requested slug. */
  | "slug-conflict"
  /** The project already has a pending transfer. */
  | "transfer-pending"
  /** The transfer was cancelled or its initiator lost the right to offer it. */
  | "transfer-invalid"
  /** The transfer's target username does not exist. */
  | "user-not-found"
  /** The deployment disabled sharing, or named a share host that was rejected. */
  | "not-configured";

/** Error thrown by the gallery fetchers, carrying a translatable {@link GalleryErrorCode}. */
export class GalleryError extends Error {
  readonly code: GalleryErrorCode;
  /** HTTP status, when `code` is `"http"`. */
  readonly status?: number;

  constructor(code: GalleryErrorCode, status?: number) {
    super(code);
    // Preserve the prototype chain so `instanceof GalleryError` holds even when
    // transpiled to a target where `extends Error` would otherwise lose it.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "GalleryError";
    this.code = code;
    this.status = status;
  }
}

/**
 * The share host for a gallery request, with a trailing slash stripped.
 *
 * @throws {GalleryError} `not-configured` when the deployment disabled sharing or
 *   named a host that was rejected — the gallery must surface that rather than
 *   quietly listing the hosted service's projects instead.
 */
function requireShareBase(override?: string): string {
  const base = override ?? resolveShareBaseUrl();
  if (!base) throw new GalleryError("not-configured");
  return base.replace(/\/+$/, "");
}

/** A project as returned by the share host's listing endpoint. */
export interface SharedProject {
  id: string;
  username: string;
  slug: string;
  title: string;
  description: string;
  visibility: string;
  organization: { id: string; slug: string; name: string } | null;
  groupIds: string[];
  /** Authoritative edit permission supplied by authenticated listing endpoints. */
  canEdit: boolean;
  /** Absolute thumbnail URL (the API returns a path; we resolve it here). */
  thumbnailUrl: string | null;
  views: number;
  forkCount: number;
  versionCount: number;
  featured: boolean;
  /**
   * The owner's "prevent deletion" switch, or `null` when the share host does
   * not expose it (an older deployment). `null` hides the toggle rather than
   * showing one that would not work.
   */
  deleteProtected: boolean | null;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  /** Absolute URL to the raw `.geolibre.json`, used to load the project. */
  rawJsonUrl: string;
  /** Absolute URL to the project page on the website. */
  projectUrl: string;
  /** Absolute URL to the standalone viewer. */
  viewerUrl: string;
}

export interface FetchSharedProjectsOptions {
  /** Page size; defaults to the endpoint's own default when omitted. */
  limit?: number;
  /** Number of records to skip, for "load more" pagination. */
  offset?: number;
  /** When true, request only featured projects (`?featured=true`). */
  featured?: boolean;
  /** Override the share host; defaults to the configured/production URL. */
  baseUrl?: string;
  signal?: AbortSignal;
  /** Injected for testing; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface FetchProjectsSharedWithMeOptions {
  token: string;
  source?: "organizations" | "groups";
  limit?: number;
  offset?: number;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface FetchSharedProjectsResult {
  projects: SharedProject[];
  /** True when the page came back full, so another page likely exists. */
  hasMore: boolean;
  /**
   * Number of records the server returned before normalization dropped any.
   * Callers must advance their pagination offset by this (not by
   * `projects.length`), or a dropped record would shift the next page and
   * re-deliver already-seen entries.
   */
  rawCount: number;
}

// Bound the request so a hung server can't leave the gallery spinning forever.
const LISTING_TIMEOUT_MS = 20_000;

interface RawSharedProject {
  id?: unknown;
  username?: unknown;
  slug?: unknown;
  title?: unknown;
  description?: unknown;
  visibility?: unknown;
  organization?: unknown;
  groupIds?: unknown;
  canEdit?: unknown;
  thumbnailUrl?: unknown;
  views?: unknown;
  forkCount?: unknown;
  versionCount?: unknown;
  featured?: unknown;
  deleteProtected?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  tags?: unknown;
  rawJsonUrl?: unknown;
  projectUrl?: unknown;
  viewerUrl?: unknown;
}

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * Resolve a thumbnail value (often a site-relative path like
 * `/api/thumbnails/...`) into an absolute URL against the share host. Returns
 * `null` when there is no usable value so the UI can show a placeholder.
 */
export function resolveThumbnailUrl(value: unknown, base: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new URL(value, `${base}/`).toString();
  } catch {
    return null;
  }
}

/**
 * Normalize one raw record from the API into a {@link SharedProject}. Returns
 * `null` when the record lacks the fields the gallery needs to render or open it
 * (a usable id and raw JSON URL), so a single malformed entry can't break the
 * whole page. `title` may be empty; the UI substitutes a translated placeholder.
 */
function normalizeProject(raw: RawSharedProject, base: string): SharedProject | null {
  const id = asString(raw.id);
  const rawJsonUrl = asString(raw.rawJsonUrl);
  if (!id || !rawJsonUrl) return null;

  return {
    id,
    username: asString(raw.username),
    slug: asString(raw.slug),
    title: asString(raw.title),
    description: asString(raw.description),
    visibility: asString(raw.visibility),
    organization:
      raw.organization &&
      typeof raw.organization === "object" &&
      typeof (raw.organization as { id?: unknown }).id === "string"
        ? {
            id: (raw.organization as { id: string }).id,
            slug: asString((raw.organization as { slug?: unknown }).slug),
            name: asString((raw.organization as { name?: unknown }).name),
          }
        : null,
    groupIds: Array.isArray(raw.groupIds)
      ? raw.groupIds.filter((groupId): groupId is string => typeof groupId === "string")
      : [],
    // Missing permission metadata must never grant write access.
    canEdit: raw.canEdit === true,
    thumbnailUrl: resolveThumbnailUrl(raw.thumbnailUrl, base),
    views: asNumber(raw.views),
    forkCount: asNumber(raw.forkCount),
    versionCount: asNumber(raw.versionCount),
    featured: raw.featured === true,
    deleteProtected: typeof raw.deleteProtected === "boolean" ? raw.deleteProtected : null,
    createdAt: asString(raw.createdAt),
    updatedAt: asString(raw.updatedAt),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
    rawJsonUrl,
    projectUrl: asString(raw.projectUrl),
    viewerUrl: asString(raw.viewerUrl),
  };
}

/**
 * Fetch a page of public projects from share.geolibre.app.
 *
 * @param options - Pagination (`limit`/`offset`), an optional host override, an
 *   abort `signal`, and an injectable `fetchImpl` for testing.
 * @returns The normalized projects, a `hasMore` hint (true when the page was
 *   returned full at the requested `limit`), and `rawCount` (the pre-filter
 *   record count, for advancing the next-page offset).
 * @throws {GalleryError} On a network failure, timeout, non-2xx response, or
 *   unparseable body. A caller-initiated abort propagates as the original
 *   `AbortError`.
 */
export async function fetchSharedProjects(
  options: FetchSharedProjectsOptions = {},
): Promise<FetchSharedProjectsResult> {
  const base = requireShareBase(options.baseUrl);
  // See share-fetch.ts: on desktop this routes the share host through Tauri's
  // native HTTP client so the gallery listing isn't blocked by WebView CORS.
  const fetchImpl = options.fetchImpl ?? getShareFetch();

  const params = new URLSearchParams();
  if (options.limit != null) params.set("limit", String(options.limit));
  if (options.offset) params.set("offset", String(options.offset));
  if (options.featured) params.set("featured", "true");
  const query = params.toString();
  const url = `${base}/api/projects${query ? `?${query}` : ""}`;

  // Combine the caller's abort signal (dialog close) with a hard deadline.
  const timeout = AbortSignal.timeout(LISTING_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException) {
      if (error.name === "AbortError") throw error;
      if (error.name === "TimeoutError") throw new GalleryError("timeout");
    }
    throw new GalleryError("network");
  }

  if (!response.ok) {
    throw new GalleryError("http", response.status);
  }

  // A malformed/HTML 200 body must surface as a retryable error, not an empty
  // gallery, so let a JSON parse failure throw rather than swallowing it.
  let payload: { projects?: RawSharedProject[] } | null;
  try {
    payload = (await response.json()) as {
      projects?: RawSharedProject[];
    } | null;
  } catch {
    throw new GalleryError("invalid-response");
  }
  const rawProjects = Array.isArray(payload?.projects) ? payload.projects : [];
  const projects = rawProjects
    .map((raw) => normalizeProject(raw, base))
    .filter((p): p is SharedProject => p !== null);

  // A full page (returned count meets the requested limit) implies more exist.
  // Without a limit we can't infer a next page, so report no more.
  const hasMore = options.limit != null && rawProjects.length >= options.limit;

  return { projects, hasMore, rawCount: rawProjects.length };
}

/**
 * Issue an authenticated JSON request to the share host and decode its body.
 *
 * Read-only by default. The gallery's mutations (delete protection, transfers)
 * pass `method` and `body`; a 204 (decline, cancel) resolves to `null`.
 *
 * @throws {GalleryError} `unauthorized` on 401/403, a typed code for the
 *   refusals the UI must explain (`slug-conflict`, `transfer-pending`,
 *   `transfer-invalid`, `user-not-found`), or `http`/`network`/`timeout`.
 */
async function shareAuthorizedJsonRequest(
  path: string,
  token: string,
  base: string,
  options: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
  } = {},
): Promise<unknown> {
  const authFetch = shareAuthorizedFetch(token, base, options.fetchImpl ?? getShareFetch());
  const timeout = AbortSignal.timeout(LISTING_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const headers: Record<string, string> = { Accept: "application/json" };
  let payload: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await authFetch(`${base}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: payload,
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException) {
      if (error.name === "AbortError") throw error;
      if (error.name === "TimeoutError") throw new GalleryError("timeout");
    }
    throw new GalleryError("network");
  }
  if (response.status === 401 || response.status === 403) {
    throw new GalleryError("unauthorized");
  }
  if (!response.ok) {
    // The server's refusals carry a stable `{"error": "..."}` phrase (see
    // docs/server-api.md); map the ones the UI explains to a typed code and
    // fall back to the plain status otherwise.
    let detail = "";
    try {
      const errorBody = (await response.json()) as { error?: unknown } | null;
      detail = typeof errorBody?.error === "string" ? errorBody.error : "";
    } catch {
      detail = "";
    }
    if (response.status === 409) {
      if (detail.includes("slug already exists")) throw new GalleryError("slug-conflict");
      if (detail.includes("transfer is already pending")) {
        throw new GalleryError("transfer-pending");
      }
      if (detail.includes("no longer valid")) throw new GalleryError("transfer-invalid");
    }
    if (response.status === 404 && detail === "user not found") {
      throw new GalleryError("user-not-found");
    }
    throw new GalleryError("http", response.status);
  }
  if (response.status === 204) return null;
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new GalleryError("invalid-response");
  }
}

/** Fetch one authenticated page of projects shared through the user's organizations or groups. */
export async function fetchProjectsSharedWithMe(
  options: FetchProjectsSharedWithMeOptions,
): Promise<FetchSharedProjectsResult> {
  const base = requireShareBase(options.baseUrl);
  const params = new URLSearchParams({ shared_with_me: "true" });
  if (options.source) params.set("shared_source", options.source);
  if (options.limit != null) params.set("limit", String(options.limit));
  if (options.offset) params.set("offset", String(options.offset));

  const payload = (await shareAuthorizedJsonRequest(
    `/api/projects?${params}`,
    options.token,
    base,
    { signal: options.signal, fetchImpl: options.fetchImpl },
  )) as { projects?: RawSharedProject[]; total?: unknown } | null;

  const rawProjects = Array.isArray(payload?.projects) ? payload.projects : [];
  const projects = rawProjects
    .map((raw) => normalizeProject(raw, base))
    .filter((project): project is SharedProject => project !== null);
  const hasMore =
    typeof payload?.total === "number" && Number.isFinite(payload.total)
      ? (options.offset ?? 0) + rawProjects.length < payload.total
      : options.limit != null && rawProjects.length >= options.limit;
  return { projects, hasMore, rawCount: rawProjects.length };
}

export interface FetchMyProjectsOptions {
  /** Personal API token from Settings; authenticates as the owner. */
  token: string;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * The token to open `project`'s raw JSON with, or undefined to fetch it
 * anonymously.
 *
 * Only private projects need auth — public and unlisted raw `.geolibre.json` is
 * served to anonymous callers with `Access-Control-Allow-Origin: *`. Attaching
 * `Authorization` when it is not needed is actively harmful: it makes the
 * request CORS-preflighted, and the share host answers `OPTIONS` on `/api/*`
 * but 404s it on raw project paths, so the browser blocks the open outright.
 */
export function projectOpenToken(
  project: Pick<SharedProject, "visibility">,
  token: string,
): string | undefined {
  if (!token) return undefined;
  return project.visibility === "public" || project.visibility === "unlisted" ? undefined : token;
}

/**
 * Attach the credential only to the share origin. Authenticated requests may
 * not follow redirects: browser fetch enforces redirect:"error", and the
 * native share transport translates that policy to maxRedirections:0.
 */
export function shareAuthorizedFetch(
  token: string,
  base: string,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  let baseOrigin: string | null = null;
  try {
    baseOrigin = new URL(base).origin;
  } catch {
    baseOrigin = null;
  }
  return ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let sameOrigin = false;
    try {
      sameOrigin = baseOrigin != null && new URL(href).origin === baseOrigin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      // A caller may pass a Request initialized for an issuer URL but resolved
      // to a third-party project URL. Never forward its Authorization header.
      const headers = new Headers(
        init.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      if (!headers.has("Authorization")) return baseFetch(input, init);
      headers.delete("Authorization");
      return baseFetch(input, { ...init, headers });
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    headers.set("Authorization", `Bearer ${token}`);
    return baseFetch(input, { ...init, headers, redirect: "error" });
  }) as typeof fetch;
}

export interface SharedThumbnailResult {
  url: string;
  /** True when `url` is an object URL that the caller must revoke. */
  objectUrl: boolean;
}

interface LoadSharedThumbnailOptions {
  token: string;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  createObjectUrl?: (blob: Blob) => string;
}

/** Resolve a gallery thumbnail, authenticating protected project images. */
export async function loadSharedProjectThumbnail(
  project: Pick<SharedProject, "thumbnailUrl" | "visibility">,
  options: LoadSharedThumbnailOptions,
): Promise<SharedThumbnailResult | null> {
  if (!project.thumbnailUrl) return null;
  if (project.visibility === "public" || project.visibility === "unlisted") {
    return { url: project.thumbnailUrl, objectUrl: false };
  }

  const base = requireShareBase(options.baseUrl);
  const authFetch = shareAuthorizedFetch(options.token, base, options.fetchImpl ?? getShareFetch());
  const timeout = AbortSignal.timeout(LISTING_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await authFetch(project.thumbnailUrl, { signal });
  } catch (error) {
    if (error instanceof DOMException) {
      if (error.name === "AbortError") throw error;
      if (error.name === "TimeoutError") throw new GalleryError("timeout");
    }
    throw new GalleryError("network");
  }
  if (!response.ok) throw new GalleryError("http", response.status);
  const blob = await response.blob();
  return {
    url: (options.createObjectUrl ?? URL.createObjectURL)(blob),
    objectUrl: true,
  };
}

/**
 * List the signed-in user's own projects, including their `unlisted` and
 * `private` ones, by authenticating with a personal API token. Resolves the
 * caller's username via `/api/users/me`, then fetches
 * `/api/users/{username}/projects` (which returns every project the owner can
 * see). This endpoint is not paginated, so the full set is returned at once.
 *
 * @throws {GalleryError} When the token is rejected (`unauthorized`), the
 *   account has no username (`username-required`), or the network/host fails. A
 *   caller-initiated abort propagates as `AbortError`.
 */
export async function fetchMyProjects(options: FetchMyProjectsOptions): Promise<SharedProject[]> {
  const base = requireShareBase(options.baseUrl);
  const username = await fetchMyShareUsername(options);

  const pageSize = 100;
  const maxPages = 1000;
  const rawProjects: RawSharedProject[] = [];
  let previousPageIds: Set<string> | null = null;
  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const payload = (await shareAuthorizedJsonRequest(
      `/api/users/${encodeURIComponent(username)}/projects?limit=${pageSize}&offset=${offset}`,
      options.token,
      base,
      { signal: options.signal, fetchImpl: options.fetchImpl },
    )) as { projects?: RawSharedProject[] } | null;
    const items = Array.isArray(payload?.projects) ? payload.projects : [];
    const currentIds = new Set(
      items.map((p) => (p && typeof p.id === "string" ? p.id : "")).filter(Boolean),
    );
    if (
      previousPageIds &&
      currentIds.size > 0 &&
      currentIds.size === previousPageIds.size &&
      [...currentIds].every((id) => previousPageIds?.has(id))
    ) {
      break;
    }
    previousPageIds = currentIds;
    rawProjects.push(...items);
    if (items.length < pageSize) break;
  }
  return rawProjects
    .map((raw) => normalizeProject(raw, base))
    .filter((p): p is SharedProject => p !== null);
}

/**
 * An organization as returned by the share server.
 */
export interface ShareOrganization {
  id: string;
  slug: string;
  name: string;
  publicSharingPolicy: "yes" | "publishers" | "no";
  defaultVisibility: "public" | "unlisted" | "private" | "organization";
  categories: string[];
  role: string | null;
}

/**
 * A group as returned by the share server.
 */
export interface ShareGroup {
  id: string;
  name: string;
  description: string;
  organizationId: string | null;
  joinPolicy: "invite" | "request" | "open";
  sharedUpdate: boolean;
  role: string | null;
}

export type PublicSharingRestriction = "organization-disabled" | "publisher-required" | null;

/** Explain whether the selected organization permits this member to publish publicly. */
export function publicSharingRestriction(
  organization: ShareOrganization | null,
): PublicSharingRestriction {
  if (!organization || organization.publicSharingPolicy === "yes") return null;
  if (organization.role === "administrator") return null;
  if (organization.publicSharingPolicy === "no") return "organization-disabled";
  return organization.role === "publisher" ? null : "publisher-required";
}

/** Public-sharing policy applies only to the public visibility choice. */
export function isPublicSharingBlocked(
  visibility: string,
  organization: ShareOrganization | null,
): boolean {
  return visibility === "public" && publicSharingRestriction(organization) !== null;
}

/** Whether this membership may own (create) organization projects; viewers are read-only. */
export function canOwnOrganizationProjects(organization: ShareOrganization): boolean {
  return (
    organization.role === "administrator" ||
    organization.role === "publisher" ||
    organization.role === "member"
  );
}

/** Match a shared project to the organizations shown by /api/organizations/mine. */
export function isProjectInMyOrganizations(
  project: Pick<SharedProject, "organization">,
  organizations: readonly ShareOrganization[],
): boolean {
  return Boolean(
    project.organization &&
    organizations.some((organization) => organization.id === project.organization?.id),
  );
}

/** Match a shared project to the accepted memberships shown by /api/groups/mine. */
export function isProjectInMyGroups(
  project: Pick<SharedProject, "groupIds">,
  groups: readonly ShareGroup[],
): boolean {
  const memberships = new Set(groups.map((group) => group.id));
  return project.groupIds.some((groupId) => memberships.has(groupId));
}

export interface FetchOrganizationsOptions {
  token: string;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface FetchGroupsOptions {
  token: string;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Resolve the signed-in username so owner permissions hold across every gallery tab. */
export async function fetchMyShareUsername(options: FetchMyProjectsOptions): Promise<string> {
  const base = requireShareBase(options.baseUrl);
  const payload = (await shareAuthorizedJsonRequest("/api/users/me", options.token, base, {
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  })) as { user?: { username?: unknown } } | null;
  if (typeof payload?.user?.username !== "string" || !payload.user.username) {
    throw new GalleryError("username-required");
  }
  return payload.user.username;
}

/**
 * Fetch the organizations the signed-in user belongs to.
 */
export async function fetchMyOrganizations(
  options: FetchOrganizationsOptions,
): Promise<ShareOrganization[]> {
  const base = requireShareBase(options.baseUrl);
  const payload = (await shareAuthorizedJsonRequest(
    "/api/organizations/mine",
    options.token,
    base,
    { signal: options.signal, fetchImpl: options.fetchImpl },
  )) as {
    organizations?: unknown[];
  } | null;
  const raw = Array.isArray(payload?.organizations) ? payload.organizations : [];
  return raw
    .map((o): ShareOrganization | null => {
      if (!o || typeof o !== "object") return null;
      const org = o as Record<string, unknown>;
      if (
        typeof org.id !== "string" ||
        typeof org.slug !== "string" ||
        typeof org.name !== "string"
      ) {
        return null;
      }
      return {
        id: org.id,
        slug: org.slug,
        name: org.name,
        publicSharingPolicy:
          org.publicSharingPolicy === "yes" ||
          org.publicSharingPolicy === "publishers" ||
          org.publicSharingPolicy === "no"
            ? org.publicSharingPolicy
            : "publishers",
        defaultVisibility:
          org.defaultVisibility === "public" ||
          org.defaultVisibility === "unlisted" ||
          org.defaultVisibility === "private" ||
          org.defaultVisibility === "organization"
            ? org.defaultVisibility
            : "organization",
        categories: Array.isArray(org.categories)
          ? org.categories.filter((c): c is string => typeof c === "string")
          : [],
        role: typeof org.role === "string" ? org.role : null,
      };
    })
    .filter((o): o is ShareOrganization => o !== null);
}

/**
 * Fetch the groups the signed-in user belongs to.
 */
export async function fetchMyGroups(options: FetchGroupsOptions): Promise<ShareGroup[]> {
  const base = requireShareBase(options.baseUrl);
  const payload = (await shareAuthorizedJsonRequest("/api/groups/mine", options.token, base, {
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  })) as { groups?: unknown[] } | null;
  const raw = Array.isArray(payload?.groups) ? payload.groups : [];
  return raw
    .map((g): ShareGroup | null => {
      if (!g || typeof g !== "object") return null;
      const group = g as Record<string, unknown>;
      if (typeof group.id !== "string" || typeof group.name !== "string") {
        return null;
      }
      return {
        id: group.id,
        name: group.name,
        description: typeof group.description === "string" ? group.description : "",
        organizationId: typeof group.organizationId === "string" ? group.organizationId : null,
        joinPolicy:
          group.joinPolicy === "invite" ||
          group.joinPolicy === "request" ||
          group.joinPolicy === "open"
            ? group.joinPolicy
            : "invite",
        sharedUpdate: group.sharedUpdate === true,
        role: typeof group.role === "string" ? group.role : null,
      };
    })
    .filter((g): g is ShareGroup => g !== null);
}

/** A project transfer as returned by the share server (GeoLibre#1670). */
export interface ProjectTransfer {
  id: string;
  projectId: string;
  projectTitle: string;
  projectSlug: string;
  /** The initiator's username, or `null` when the project left an organization. */
  fromUsername: string | null;
  /** The recipient user, or `null` for an organization transfer. */
  toUsername: string | null;
  toOrganization: { id: string; slug: string; name: string } | null;
  /** The slug the project will take at its destination. */
  slug: string;
  status: "pending" | "accepted" | "declined" | "cancelled";
  createdAt: string;
  resolvedAt: string | null;
}

/** Normalize one transfer record, dropping malformed entries. */
function normalizeTransfer(raw: unknown): ProjectTransfer | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = asString(value.id);
  const projectId = asString(value.projectId);
  if (!id || !projectId) return null;
  const status = value.status;
  const organization = value.toOrganization;
  let toOrganization: ProjectTransfer["toOrganization"] = null;
  if (organization && typeof organization === "object") {
    // Indexable view of a parsed JSON object; each field is checked below.
    const record = organization as Record<string, unknown>;
    if (typeof record.id === "string") {
      toOrganization = {
        id: record.id,
        slug: typeof record.slug === "string" ? record.slug : "",
        name: typeof record.name === "string" ? record.name : "",
      };
    }
  }
  return {
    id,
    projectId,
    projectTitle: asString(value.projectTitle),
    projectSlug: asString(value.projectSlug),
    fromUsername: typeof value.fromUsername === "string" ? value.fromUsername : null,
    toUsername: typeof value.toUsername === "string" ? value.toUsername : null,
    toOrganization,
    slug: asString(value.slug),
    status:
      status === "pending" ||
      status === "accepted" ||
      status === "declined" ||
      status === "cancelled"
        ? status
        : "pending",
    createdAt: asString(value.createdAt),
    resolvedAt: typeof value.resolvedAt === "string" ? value.resolvedAt : null,
  };
}

export interface SetProjectDeleteProtectionOptions {
  token: string;
  projectId: string;
  deleteProtected: boolean;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Turn a project's "prevent deletion" switch on or off. While it is on the
 * share server refuses `DELETE` with a 409 naming the switch.
 *
 * @throws {GalleryError} As {@link fetchMyProjects}, plus `invalid-response` if
 *   the updated project is missing from the response.
 */
export async function setProjectDeleteProtection(
  options: SetProjectDeleteProtectionOptions,
): Promise<SharedProject> {
  const base = requireShareBase(options.baseUrl);
  const payload = (await shareAuthorizedJsonRequest(
    `/api/projects/${encodeURIComponent(options.projectId)}`,
    options.token,
    base,
    {
      method: "PATCH",
      body: { deleteProtected: options.deleteProtected },
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    },
  )) as { project?: RawSharedProject } | null;
  const project = payload?.project ? normalizeProject(payload.project, base) : null;
  if (!project) throw new GalleryError("invalid-response");
  return project;
}

/** The destination for a transfer: another user, or an organization you administer. */
export type ProjectTransferTarget = { username: string } | { organizationId: string };

export interface RequestProjectTransferOptions {
  token: string;
  projectId: string;
  target: ProjectTransferTarget;
  /** Overrides the destination slug; the server defaults to the current one. */
  slug?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface ProjectTransferResult {
  transfer: ProjectTransfer;
  /** The moved project, present once an organization transfer applies immediately. */
  project: SharedProject | null;
}

/**
 * Offer a project to another user (they must accept) or hand it to an
 * organization the caller administers (applied immediately).
 */
export async function requestProjectTransfer(
  options: RequestProjectTransferOptions,
): Promise<ProjectTransferResult> {
  const base = requireShareBase(options.baseUrl);
  const payload = (await shareAuthorizedJsonRequest(
    `/api/projects/${encodeURIComponent(options.projectId)}/transfers`,
    options.token,
    base,
    {
      method: "POST",
      body: { ...options.target, ...(options.slug ? { slug: options.slug } : {}) },
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    },
  )) as { transfer?: unknown; project?: RawSharedProject } | null;
  const transfer = normalizeTransfer(payload?.transfer);
  if (!transfer) throw new GalleryError("invalid-response");
  return {
    transfer,
    project: payload?.project ? normalizeProject(payload.project, base) : null,
  };
}

export interface FetchTransfersOptions {
  token: string;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

interface RawTransferList {
  transfers?: unknown;
}

/** List the pending transfers offered to the signed-in user. */
export async function fetchIncomingTransfers(
  options: FetchTransfersOptions,
): Promise<ProjectTransfer[]> {
  const base = requireShareBase(options.baseUrl);
  const payload = (await shareAuthorizedJsonRequest(
    "/api/transfers/incoming",
    options.token,
    base,
    { signal: options.signal, fetchImpl: options.fetchImpl },
  )) as RawTransferList | null;
  const raw = Array.isArray(payload?.transfers) ? payload.transfers : [];
  return raw.map(normalizeTransfer).filter((item): item is ProjectTransfer => item !== null);
}

/** List the signed-in user's transfers still awaiting acceptance. */
export async function fetchOutgoingTransfers(
  options: FetchTransfersOptions,
): Promise<ProjectTransfer[]> {
  const base = requireShareBase(options.baseUrl);
  const payload = (await shareAuthorizedJsonRequest(
    "/api/transfers/outgoing",
    options.token,
    base,
    { signal: options.signal, fetchImpl: options.fetchImpl },
  )) as RawTransferList | null;
  const raw = Array.isArray(payload?.transfers) ? payload.transfers : [];
  return raw.map(normalizeTransfer).filter((item): item is ProjectTransfer => item !== null);
}

export interface AcceptProjectTransferOptions {
  token: string;
  transferId: string;
  /** A replacement slug, used after the destination slug conflicts. */
  slug?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Accept a pending transfer, moving the project into the caller's namespace. */
export async function acceptProjectTransfer(
  options: AcceptProjectTransferOptions,
): Promise<ProjectTransferResult> {
  const base = requireShareBase(options.baseUrl);
  const payload = (await shareAuthorizedJsonRequest(
    `/api/transfers/${encodeURIComponent(options.transferId)}/accept`,
    options.token,
    base,
    {
      method: "POST",
      body: options.slug ? { slug: options.slug } : {},
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    },
  )) as { transfer?: unknown; project?: RawSharedProject } | null;
  const transfer = normalizeTransfer(payload?.transfer);
  if (!transfer) throw new GalleryError("invalid-response");
  return {
    transfer,
    project: payload?.project ? normalizeProject(payload.project, base) : null,
  };
}

export interface TransferIdOptions {
  token: string;
  transferId: string;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Decline a transfer offered to the caller. */
export async function declineProjectTransfer(options: TransferIdOptions): Promise<void> {
  const base = requireShareBase(options.baseUrl);
  await shareAuthorizedJsonRequest(
    `/api/transfers/${encodeURIComponent(options.transferId)}/decline`,
    options.token,
    base,
    {
      method: "POST",
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    },
  );
}

/** Cancel a pending transfer the caller started or can still manage. */
export async function cancelProjectTransfer(options: TransferIdOptions): Promise<void> {
  const base = requireShareBase(options.baseUrl);
  await shareAuthorizedJsonRequest(
    `/api/transfers/${encodeURIComponent(options.transferId)}`,
    options.token,
    base,
    {
      method: "DELETE",
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    },
  );
}
