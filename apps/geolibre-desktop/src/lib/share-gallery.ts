// Lists publicly shared projects from share.geolibre.app's `GET /api/projects`
// endpoint so the Project Gallery can browse and open them. This is the read
// counterpart to share-geolibre.ts (which uploads via `POST /api/projects`).
//
// `fetchSharedProjects` reads the public listing (`GET /api/projects`, no
// token) with `limit` + `offset` pagination. `fetchMyProjects` authenticates
// with a personal API token to also return the signed-in user's `unlisted` and
// `private` projects.

import { resolveShareBaseUrl } from "./share-geolibre";

/** A public project as returned by share.geolibre.app's listing endpoint. */
export interface SharedProject {
  id: string;
  username: string;
  slug: string;
  title: string;
  description: string;
  visibility: string;
  /** Absolute thumbnail URL (the API returns a path; we resolve it here). */
  thumbnailUrl: string | null;
  views: number;
  forkCount: number;
  versionCount: number;
  featured: boolean;
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
  /** Override the share host; defaults to the configured/production URL. */
  baseUrl?: string;
  signal?: AbortSignal;
  /** Injected for testing; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface FetchSharedProjectsResult {
  projects: SharedProject[];
  /** True when the page came back full, so another page likely exists. */
  hasMore: boolean;
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
  thumbnailUrl?: unknown;
  views?: unknown;
  forkCount?: unknown;
  versionCount?: unknown;
  featured?: unknown;
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
export function resolveThumbnailUrl(
  value: unknown,
  base: string,
): string | null {
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
 * (a usable id, title, and raw JSON URL), so a single malformed entry can't
 * break the whole page.
 */
function normalizeProject(
  raw: RawSharedProject,
  base: string,
): SharedProject | null {
  const id = asString(raw.id);
  const rawJsonUrl = asString(raw.rawJsonUrl);
  if (!id || !rawJsonUrl) return null;

  return {
    id,
    username: asString(raw.username),
    slug: asString(raw.slug),
    title: asString(raw.title) || "Untitled Project",
    description: asString(raw.description),
    visibility: asString(raw.visibility),
    thumbnailUrl: resolveThumbnailUrl(raw.thumbnailUrl, base),
    views: asNumber(raw.views),
    forkCount: asNumber(raw.forkCount),
    versionCount: asNumber(raw.versionCount),
    featured: raw.featured === true,
    createdAt: asString(raw.createdAt),
    updatedAt: asString(raw.updatedAt),
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((t): t is string => typeof t === "string")
      : [],
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
 * @returns The normalized projects plus a `hasMore` hint (true when the page was
 *   returned full at the requested `limit`).
 * @throws {Error} With a descriptive message on a network failure, a timeout, a
 *   non-2xx response, or an unparseable body. A caller-initiated abort
 *   propagates as the original `AbortError`.
 */
export async function fetchSharedProjects(
  options: FetchSharedProjectsOptions = {},
): Promise<FetchSharedProjectsResult> {
  const base = (options.baseUrl ?? resolveShareBaseUrl()).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  const params = new URLSearchParams();
  if (options.limit != null) params.set("limit", String(options.limit));
  if (options.offset) params.set("offset", String(options.offset));
  const query = params.toString();
  const url = `${base}/api/projects${query ? `?${query}` : ""}`;

  // Combine the caller's abort signal (dialog close) with a hard deadline.
  const timeout = AbortSignal.timeout(LISTING_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException) {
      if (error.name === "AbortError") throw error;
      if (error.name === "TimeoutError") {
        throw new Error("The project gallery timed out. Please try again.");
      }
    }
    throw new Error(
      "Could not reach share.geolibre.app. Check your internet connection.",
    );
  }

  if (!response.ok) {
    throw new Error(`Could not load the gallery (HTTP ${response.status}).`);
  }

  const payload = (await response.json().catch(() => null)) as {
    projects?: RawSharedProject[];
  } | null;
  const rawProjects = Array.isArray(payload?.projects) ? payload.projects : [];
  const projects = rawProjects
    .map((raw) => normalizeProject(raw, base))
    .filter((p): p is SharedProject => p !== null);

  // A full page (returned count meets the requested limit) implies more exist.
  // Without a limit we can't infer a next page, so report no more.
  const hasMore =
    options.limit != null && rawProjects.length >= options.limit;

  return { projects, hasMore };
}

export interface FetchMyProjectsOptions {
  /** Personal API token from Settings; authenticates as the owner. */
  token: string;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Wrap a fetch so requests to the share host carry the personal API token. The
 * `Authorization` header is attached only for same-origin-as-`base` URLs so the
 * token is never leaked to a third-party host (e.g. an external tile server
 * referenced by a project).
 */
export function shareAuthorizedFetch(token: string, base: string): typeof fetch {
  let baseOrigin: string | null = null;
  try {
    baseOrigin = new URL(base).origin;
  } catch {
    baseOrigin = null;
  }
  return (input: RequestInfo | URL, init: RequestInit = {}) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    let sameHost = false;
    try {
      sameHost = baseOrigin != null && new URL(href).origin === baseOrigin;
    } catch {
      sameHost = false;
    }
    if (!sameHost) return fetch(input, init);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
}

/**
 * List the signed-in user's own projects, including their `unlisted` and
 * `private` ones, by authenticating with a personal API token. Resolves the
 * caller's username via `/api/users/me`, then fetches
 * `/api/users/{username}/projects` (which returns every project the owner can
 * see). This endpoint is not paginated, so the full set is returned at once.
 *
 * @throws {Error} When the token is rejected, the account has no username yet,
 *   or the network/host fails. A caller-initiated abort propagates as
 *   `AbortError`.
 */
export async function fetchMyProjects(
  options: FetchMyProjectsOptions,
): Promise<SharedProject[]> {
  const base = (options.baseUrl ?? resolveShareBaseUrl()).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const authFetch = shareAuthorizedFetch(options.token, base);

  const timeout = AbortSignal.timeout(LISTING_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;

  const request = async (path: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await (options.fetchImpl
        ? fetchImpl(`${base}${path}`, {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${options.token}`,
            },
            signal,
          })
        : authFetch(`${base}${path}`, {
            headers: { Accept: "application/json" },
            signal,
          }));
    } catch (error) {
      if (error instanceof DOMException) {
        if (error.name === "AbortError") throw error;
        if (error.name === "TimeoutError") {
          throw new Error("Loading your projects timed out. Please try again.");
        }
      }
      throw new Error(
        "Could not reach share.geolibre.app. Check your internet connection.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "Your share.geolibre.app API token is invalid or expired. Update it in Settings.",
      );
    }
    if (!response.ok) {
      throw new Error(`Could not load your projects (HTTP ${response.status}).`);
    }
    return response.json().catch(() => null);
  };

  const me = (await request("/api/users/me")) as {
    user?: { username?: string | null };
  } | null;
  const username = me?.user?.username;
  if (!username) {
    throw new Error(
      "Set a username on your share.geolibre.app account before loading your projects.",
    );
  }

  const payload = (await request(
    `/api/users/${encodeURIComponent(username)}/projects`,
  )) as { projects?: RawSharedProject[] } | null;
  const rawProjects = Array.isArray(payload?.projects) ? payload.projects : [];
  return rawProjects
    .map((raw) => normalizeProject(raw, base))
    .filter((p): p is SharedProject => p !== null);
}
