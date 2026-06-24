// Lists publicly shared projects from share.geolibre.app's `GET /api/projects`
// endpoint so the Project Gallery can browse and open them. This is the read
// counterpart to share-geolibre.ts (which uploads via `POST /api/projects`).
//
// The listing endpoint is public (no API token) and returns only `public`
// projects. It supports `limit` + `offset` pagination; it does NOT honor
// server-side `search`/`sort` parameters, so the dialog filters the loaded page
// set client-side.

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
