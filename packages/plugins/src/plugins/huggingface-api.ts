/**
 * Hugging Face Hub (https://huggingface.co) dataset API client.
 *
 * Hugging Face hosts a growing amount of cloud-native geospatial data in
 * **dataset repos** — COG, GeoParquet, PMTiles, FlatGeobuf, GeoJSON — and,
 * unlike most catalogs GeoLibre browses, it is *writable*: with a user access
 * token the same panel can create a dataset repo and push files into it.
 *
 * Three things shape this module:
 *
 *  1. **Everything here is browser-reachable.** `huggingface.co/api/*` reflects
 *     the request origin in `Access-Control-Allow-Origin`, and the file
 *     endpoint (`/datasets/{repo}/resolve/{rev}/{path}`) 302s to a CDN that
 *     answers range requests with `Access-Control-Allow-Origin: *`. So there is
 *     no Worker proxy in this file — unlike `source-coop-api.ts`, whose
 *     metadata API sends no CORS headers at all.
 *
 *  2. **Reads work without a token; writes never do.** Public repos list and
 *     resolve anonymously. A token is only consulted for the account's own
 *     repos, repo creation, and upload. It is passed as a bearer header and is
 *     never put in a URL — a resolve URL becomes a map source and would leak
 *     the token into MapLibre's request log and any saved project.
 *
 *  3. **Upload is the git-LFS dance, not a plain PUT.** Hugging Face decides
 *     per file whether it goes into git directly or through LFS (`preupload`),
 *     and an LFS file must be hashed, registered with the LFS batch endpoint,
 *     PUT to the storage URL that returns, then referenced by hash in the
 *     commit. {@link uploadDatasetFiles} implements exactly that sequence; the
 *     comments on each step record the wire details that are easy to get wrong.
 *
 * Deliberately DOM-free and framework-free so it can be unit tested under
 * `node --test`; everything that touches the map or the document lives in
 * `maplibre-huggingface.ts`. What GeoLibre can *do* with a listed file (format,
 * reader, size limits) is shared with the other remote-browse panels and lives
 * in `remote-file-formats.ts`.
 */

import { classifyPath, type RemoteFileFormat } from "./remote-file-formats";

/** The Hugging Face Hub website and API root. */
export const HF_SITE = "https://huggingface.co";
export const HF_API_BASE = `${HF_SITE}/api`;

/** The branch a dataset is read from and written to unless told otherwise. */
export const HF_DEFAULT_REVISION = "main";

/** Page size for a dataset listing. The Hub's own ceiling for these routes. */
export const HF_DATASET_PAGE_SIZE = 100;

/** Page size for a repo file listing. The Hub's `tree` ceiling is 1000. */
export const HF_TREE_PAGE_SIZE = 500;

/**
 * Largest file this client will upload.
 *
 * The LFS `basic` transfer this module requests hands back a single storage URL
 * that the whole file is PUT to in one request. The Hub's storage rejects a
 * single-part upload past 5 GB, and a browser must hold the bytes in memory to
 * send them anyway. `multipart` transfer would lift this, at the cost of
 * chunking and per-part completion — worth adding only once someone needs it.
 */
export const HF_MAX_UPLOAD_BYTES = 5 * 1024 ** 3;

/**
 * Largest total selection this client will upload in one commit.
 *
 * A separate limit from {@link HF_MAX_UPLOAD_BYTES} because it bounds something
 * else: every selected file is read into memory before the single commit that
 * carries them, and the non-LFS ones are base64-encoded on top of that. So a
 * selection of individually-legal files can still exhaust the tab. Same value
 * today, but they are free to diverge — this one tracks browser memory, that
 * one tracks what the storage endpoint accepts in one PUT.
 */
export const HF_MAX_UPLOAD_TOTAL_BYTES = 5 * 1024 ** 3;

/** Bytes of each file sent to `preupload` so the Hub can classify it. */
const PREUPLOAD_SAMPLE_BYTES = 512;

/** One dataset repo. */
export interface HfDataset {
  /** `owner/name`, the id every other route takes. */
  id: string;
  owner: string;
  name: string;
  /** Private repos are listed (with a token) but cannot be rendered — see {@link canRenderFrom}. */
  private: boolean;
  /** Gated repos need per-user terms acceptance, so they render like private ones. */
  gated: boolean;
  likes: number;
  downloads: number;
  /** ISO timestamp, or null when the API did not report one. */
  lastModified: string | null;
  tags: string[];
  /** The repo's page on huggingface.co. */
  url: string;
}

/** One file in a dataset repo. */
export interface HfFile {
  /** Repo-relative path, including any folders. */
  path: string;
  /** Trailing path segment, for display. */
  name: string;
  size: number;
  format: RemoteFileFormat;
  /** Absolute, browser-fetchable URL that 302s to the CDN. */
  url: string;
  /** Whether the blob is stored in LFS. Purely informational here. */
  lfs: boolean;
}

/** One page of a repo's file listing. */
export interface HfTreeListing {
  files: HfFile[];
  /** Subfolder paths, repo-relative and without a trailing slash. */
  folders: string[];
  /** Cursor for the next page, or null when the listing is complete. */
  nextCursor: string | null;
}

/** Minimal request shape, so tests can stub the network without a DOM. */
export interface HfRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

/** Minimal response shape. `headers` is optional so a stub need not model it. */
export interface HfResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  headers?: { get: (name: string) => string | null };
}

/** Minimal fetch shape. Mirrors `SourceCoopFetch` in `source-coop-api.ts`. */
export type HfFetch = (url: string, init?: HfRequestInit) => Promise<HfResponse>;

const defaultFetch: HfFetch = (url, init) => fetch(url, init as RequestInit);

/** Shared options for every call in this module. */
export interface HfClientOptions {
  /** API root, overridable for tests. Defaults to {@link HF_API_BASE}. */
  endpoint?: string;
  /** A user access token. Required for writes; optional for reads. */
  token?: string;
  fetchImpl?: HfFetch;
  signal?: AbortSignal;
}

/** `owner/name`, the id form a user can paste into the search box. */
const REPO_ID_RE = /^([a-z0-9][a-z0-9-_.]*)\/([a-z0-9][a-z0-9-_.]*)\/?$/i;

/** A bare account name, with no slash. */
const OWNER_RE = /^[a-z0-9][a-z0-9-_.]*$/i;

/**
 * Splits `owner/name` out of a query string, or returns null when the query is
 * free text or a bare account name.
 *
 * @param value - Raw user input
 * @returns The owner and repo name, or null
 */
export function parseRepoId(value: string): { owner: string; name: string } | null {
  const match = REPO_ID_RE.exec(value.trim());
  return match ? { owner: match[1], name: match[2] } : null;
}

/**
 * Whether a string is a plausible account name (an owner with no repo part).
 *
 * @param value - Raw user input
 * @returns True when the value could name an account
 */
export function isOwnerName(value: string): boolean {
  return OWNER_RE.test(value.trim());
}

/**
 * A dataset's page on huggingface.co — the human-facing link, not a data URL
 * (that is {@link buildResolveUrl}).
 *
 * @param repoId - `owner/name`
 * @returns The repo's web page
 */
export function datasetUrl(repoId: string): string {
  return `${HF_SITE}/datasets/${encodeRepoId(repoId)}`;
}

/**
 * Whether GeoLibre can fetch a repo's files from the browser at all.
 *
 * Private and gated repos are readable only with an `Authorization` header, and
 * a map source is a plain URL with no place to put one — MapLibre, the PMTiles
 * protocol, and DuckDB-WASM all issue their own unauthenticated requests. So a
 * panel may *list* these repos (the listing call can carry the header) but must
 * not offer to add or download their files.
 *
 * @param dataset - The dataset record
 * @returns True when the repo's files are anonymously fetchable
 */
export function canRenderFrom(dataset: HfDataset): boolean {
  return !dataset.private && !dataset.gated;
}

/**
 * Percent-encodes a repo id's segments while keeping the `/` between owner and
 * name intact — `encodeURIComponent` on the whole id would turn that into
 * `%2F` and 404.
 */
function encodeRepoId(repoId: string): string {
  return repoId.split("/").map(encodeURIComponent).join("/");
}

/**
 * Builds the browser-fetchable URL for one file in a dataset.
 *
 * Each path segment is encoded individually: repo paths legitimately contain
 * `/`, and geospatial datasets are often Hive-partitioned (`year=2024/x.parquet`),
 * so the `=` must survive intact.
 *
 * @param repoId - `owner/name`
 * @param path - Repo-relative file path
 * @param revision - Branch, tag, or commit; defaults to `main`
 * @returns The `resolve` URL, which 302s to the CDN
 */
export function buildResolveUrl(
  repoId: string,
  path: string,
  revision: string = HF_DEFAULT_REVISION,
): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${HF_SITE}/datasets/${encodeRepoId(repoId)}/resolve/${encodeURIComponent(revision)}/${encodedPath}`;
}

/**
 * The download form of a resolve URL. `?download=true` makes the Hub send
 * `Content-Disposition: attachment`, so the browser saves the file instead of
 * navigating to it (a `.csv` or `.geojson` would otherwise render in the tab).
 *
 * @param url - A resolve URL from {@link buildResolveUrl}
 * @returns The same URL, flagged for download
 */
export function buildDownloadUrl(url: string): string {
  return url.includes("?") ? `${url}&download=true` : `${url}?download=true`;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Normalizes one raw dataset record. Returns null when the record has no usable
 * identity, which is also how a non-dataset body gets rejected.
 *
 * @param raw - A record from `/api/datasets` or `/api/datasets/{id}`
 * @returns The normalized dataset, or null
 */
export function parseDataset(raw: unknown): HfDataset | null {
  const record = asRecord(raw);
  const id = asString(record.id);
  const ref = parseRepoId(id);
  if (!ref) return null;
  // A disabled repo returns 403 on every file read, so offering it would only
  // produce failures. Mirrors the `disabled` filter in source-coop-api.
  if (record.disabled === true) return null;

  const rawTags = record.tags;
  const tags = Array.isArray(rawTags)
    ? rawTags.filter((tag): tag is string => typeof tag === "string")
    : [];

  return {
    id: `${ref.owner}/${ref.name}`,
    owner: ref.owner,
    name: ref.name,
    private: record.private === true,
    // `gated` is `false | "auto" | "manual"` in the API, not a boolean, so any
    // truthy value means the repo is behind terms acceptance.
    gated: Boolean(record.gated),
    likes: asNumber(record.likes),
    downloads: asNumber(record.downloads),
    lastModified: asString(record.lastModified) || null,
    tags,
    url: datasetUrl(id),
  };
}

/**
 * Normalizes a dataset list body. The Hub returns a bare array; an object
 * wrapping one under `datasets` is also accepted.
 *
 * @param body - The parsed response body
 * @returns Every dataset the body describes
 */
export function parseDatasetList(body: unknown): HfDataset[] {
  const raw = Array.isArray(body) ? body : asRecord(body).datasets;
  if (!Array.isArray(raw)) return [];
  return raw.map(parseDataset).filter((dataset): dataset is HfDataset => dataset !== null);
}

/**
 * Normalizes a `tree` body into files and folders.
 *
 * An LFS-backed entry reports the real blob size at the top level *and* under
 * `lfs.size`; the top-level value is authoritative, so it is used directly and
 * `lfs` only records how the blob is stored.
 *
 * @param body - The parsed `tree` response body
 * @param repoId - `owner/name`, needed to build each file's URL
 * @param revision - The revision the tree was read at
 * @returns The listing, minus its cursor (which comes from a response header)
 */
export function parseTree(
  body: unknown,
  repoId: string,
  revision: string = HF_DEFAULT_REVISION,
): Omit<HfTreeListing, "nextCursor"> {
  const entries = Array.isArray(body) ? body : [];
  const files: HfFile[] = [];
  const folders: string[] = [];

  for (const entry of entries) {
    const record = asRecord(entry);
    const path = asString(record.path);
    if (!path) continue;
    if (record.type === "directory") {
      folders.push(path);
      continue;
    }
    if (record.type !== "file") continue;
    files.push({
      path,
      name: path.split("/").pop() ?? path,
      size: asNumber(record.size),
      format: classifyPath(path),
      url: buildResolveUrl(repoId, path, revision),
      lfs: Boolean(record.lfs),
    });
  }

  return { files, folders };
}

/**
 * Reads the `rel="next"` cursor out of a `Link` header.
 *
 * The Hub paginates `tree` and `datasets` with an opaque cursor carried in a
 * `Link` header rather than in the body. It is exposed to browsers via
 * `Access-Control-Expose-Headers`, but a caller that cannot see headers (a test
 * stub, a fetch shim) simply gets null and stops after one page.
 *
 * @param header - The raw `Link` header value, if any
 * @returns The `cursor` query value of the next page, or null
 */
export function parseNextCursor(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /<([^>]+)>\s*;\s*rel="next"/i.exec(header);
  if (!match) return null;
  try {
    return new URL(match[1]).searchParams.get("cursor");
  } catch {
    return null;
  }
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function resolveEndpoint(options: HfClientOptions): string {
  return (options.endpoint ?? HF_API_BASE).replace(/\/+$/, "");
}

/**
 * Reads the Hub's error message out of a failed response body.
 *
 * The Hub reports failures as `{"error": "..."}`, which is far more use than a
 * bare status — "You don't have the rights to create a dataset under this
 * namespace" versus "403".
 */
function errorFromBody(body: string, status: number): Error {
  try {
    const parsed = asRecord(JSON.parse(body));
    const message = asString(parsed.error) || asString(parsed.message);
    if (message) return new Error(message);
  } catch {
    // Not JSON — fall through to the status.
  }
  return new Error(`Hugging Face request failed (${status})`);
}

/** Issues a request and returns the raw response, throwing on a non-2xx. */
async function request(
  url: string,
  options: HfClientOptions,
  init: HfRequestInit = {},
): Promise<HfResponse> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const response = await fetchImpl(url, {
    ...init,
    headers: { ...authHeaders(options.token), ...(init.headers ?? {}) },
    signal: init.signal ?? options.signal,
  });
  if (!response.ok) {
    throw errorFromBody(await response.text(), response.status);
  }
  return response;
}

/** Issues a request and parses a JSON body. */
async function requestJson(
  url: string,
  options: HfClientOptions,
  init: HfRequestInit = {},
): Promise<{ body: unknown; response: HfResponse }> {
  const response = await request(url, options, init);
  const text = await response.text();
  try {
    return { body: JSON.parse(text) as unknown, response };
  } catch {
    throw new Error("Hugging Face returned an unexpected response");
  }
}

function jsonInit(method: string, payload: unknown): HfRequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

/**
 * Lists the public dataset repos owned by one account, newest first.
 *
 * With a token that owns the account, the account's private repos are included
 * too — which is what makes a just-created repo show up without a page reload.
 *
 * @param owner - The account (user or organization) name
 * @param options - Client options
 * @returns The account's datasets
 */
export async function listOwnerDatasets(
  owner: string,
  options: HfClientOptions = {},
): Promise<HfDataset[]> {
  const url = new URL(`${resolveEndpoint(options)}/datasets`);
  url.searchParams.set("author", owner);
  url.searchParams.set("limit", String(HF_DATASET_PAGE_SIZE));
  url.searchParams.set("sort", "lastModified");
  url.searchParams.set("direction", "-1");
  const { body } = await requestJson(url.href, options);
  return parseDatasetList(body);
}

/**
 * Full-text search across public dataset repos.
 *
 * Unlike Source Cooperative, the Hub has a real search endpoint, so there is no
 * client-side catalog to assemble and filter here.
 *
 * @param query - Free-text query
 * @param options - Client options
 * @returns Matching datasets, most relevant first
 */
export async function searchDatasets(
  query: string,
  options: HfClientOptions = {},
): Promise<HfDataset[]> {
  const url = new URL(`${resolveEndpoint(options)}/datasets`);
  url.searchParams.set("search", query);
  url.searchParams.set("limit", String(HF_DATASET_PAGE_SIZE));
  const { body } = await requestJson(url.href, options);
  return parseDatasetList(body);
}

/**
 * Fetches one dataset by id, or null when it does not exist or is not visible
 * to the supplied token.
 *
 * @param repoId - `owner/name`
 * @param options - Client options
 * @returns The dataset, or null
 */
export async function fetchDataset(
  repoId: string,
  options: HfClientOptions = {},
): Promise<HfDataset | null> {
  try {
    const { body } = await requestJson(
      `${resolveEndpoint(options)}/datasets/${encodeRepoId(repoId)}`,
      options,
    );
    return parseDataset(body);
  } catch {
    return null;
  }
}

/**
 * Lists one folder of a dataset repo.
 *
 * Non-recursive by design: a geospatial dataset can hold tens of thousands of
 * tiles, and the panel browses folder by folder like a file manager rather than
 * flattening the whole repo into one list.
 *
 * @param request_ - Which repo, folder, revision, and page to read
 * @param options - Client options
 * @returns One page of files and folders
 */
export async function listDatasetTree(
  request_: {
    repoId: string;
    /** Repo-relative folder path; empty for the repo root. */
    path?: string;
    revision?: string;
    cursor?: string | null;
  },
  options: HfClientOptions = {},
): Promise<HfTreeListing> {
  const revision = request_.revision ?? HF_DEFAULT_REVISION;
  const path = (request_.path ?? "").replace(/^\/+|\/+$/g, "");
  const suffix = path
    ? `/${path
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")}`
    : "";
  const url = new URL(
    `${resolveEndpoint(options)}/datasets/${encodeRepoId(request_.repoId)}/tree/${encodeURIComponent(revision)}${suffix}`,
  );
  url.searchParams.set("limit", String(HF_TREE_PAGE_SIZE));
  if (request_.cursor) url.searchParams.set("cursor", request_.cursor);

  const { body, response } = await requestJson(url.href, options);
  return {
    ...parseTree(body, request_.repoId, revision),
    nextCursor: parseNextCursor(response.headers?.get("Link")),
  };
}

/** Who a token belongs to, and what it may do. */
export interface HfIdentity {
  /** The account name the token authenticates as. */
  name: string;
  /** Organizations the account belongs to, as candidate repo namespaces. */
  orgs: string[];
  /**
   * Whether the token may write. A `read`-scoped fine-grained token
   * authenticates fine but fails at repo creation, so the panel checks this up
   * front rather than letting the user fill in a form that cannot succeed.
   */
  canWrite: boolean;
}

/**
 * Identifies a token, which doubles as validating it.
 *
 * @param options - Client options; `token` is required
 * @returns The token's identity
 */
export async function whoAmI(options: HfClientOptions): Promise<HfIdentity> {
  if (!options.token) throw new Error("A Hugging Face access token is required.");
  const { body } = await requestJson(`${resolveEndpoint(options)}/whoami-v2`, options);
  const record = asRecord(body);
  const rawOrgs = Array.isArray(record.orgs) ? record.orgs : [];
  const auth = asRecord(record.auth);
  const accessToken = asRecord(auth.accessToken);
  const role = asString(accessToken.role);
  return {
    name: asString(record.name),
    orgs: rawOrgs.map((org) => asString(asRecord(org).name)).filter(Boolean),
    // Classic tokens report `role` ("read"/"write"); fine-grained ones report
    // no role at all, and their permissions are per-repo and not knowable here.
    // Treat an absent role as "possibly writable" so a fine-grained token is
    // not rejected before it has been tried — the create/commit call is the
    // real authority and its error message is specific.
    canWrite: role !== "read",
  };
}

/**
 * Creates a dataset repo.
 *
 * @param spec - The repo to create. `owner` may be the token's own account or
 *   an organization it belongs to; omit it to use the token's account.
 * @param options - Client options; `token` is required
 * @returns The created repo's id and page URL
 */
export async function createDatasetRepo(
  spec: { name: string; owner?: string; private?: boolean },
  options: HfClientOptions,
): Promise<{ repoId: string; url: string }> {
  if (!options.token) throw new Error("A Hugging Face access token is required.");
  const name = spec.name.trim();
  if (!name) throw new Error("A dataset name is required.");
  // A slash here would be silently accepted as part of the name and produce an
  // unusable repo, so route it to the namespace field the API actually has.
  if (name.includes("/")) {
    throw new Error("Enter the dataset name only; choose the owner separately.");
  }

  const { body } = await requestJson(
    `${resolveEndpoint(options)}/repos/create`,
    options,
    jsonInit("POST", {
      type: "dataset",
      name,
      ...(spec.owner ? { organization: spec.owner } : {}),
      private: spec.private ?? false,
    }),
  );
  const record = asRecord(body);
  // The response's `name` is the bare repo name for a personal repo but the
  // full `owner/name` for an org one, so the id is recovered from `url` (always
  // absolute and complete) and only composed by hand as a fallback.
  const url = asString(record.url);
  const fromUrl = url ? parseRepoId(url.replace(`${HF_SITE}/datasets/`, "")) : null;
  const repoId = fromUrl ? `${fromUrl.owner}/${fromUrl.name}` : `${spec.owner ?? ""}/${name}`;
  return { repoId, url: url || datasetUrl(repoId) };
}

/** One file to upload. */
export interface HfUploadFile {
  /** Repo-relative destination path. */
  path: string;
  content: Uint8Array;
}

/** Progress for the upload sequence, reported per file as it advances. */
export interface HfUploadProgress {
  phase: "preparing" | "hashing" | "uploading" | "committing";
  /** The file being worked on, or empty during repo-wide phases. */
  path: string;
  /** 1-based index of that file, and how many there are in total. */
  index: number;
  total: number;
}

/** Base64 alphabet, for {@link bytesToBase64}. */
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Encodes bytes as base64.
 *
 * Hand-rolled rather than using `btoa`, which takes a string and so would need
 * every byte widened to a code unit first — a second full-size copy of the file
 * in memory, on a path that already holds one.
 *
 * @param bytes - The bytes to encode
 * @returns The base64 text
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const byte1 = bytes[index];
    const byte2 = bytes[index + 1];
    const byte3 = bytes[index + 2];
    out += BASE64_ALPHABET[byte1 >> 2];
    out += BASE64_ALPHABET[((byte1 & 0x03) << 4) | ((byte2 ?? 0) >> 4)];
    out += byte2 === undefined ? "=" : BASE64_ALPHABET[((byte2 & 0x0f) << 2) | ((byte3 ?? 0) >> 6)];
    out += byte3 === undefined ? "=" : BASE64_ALPHABET[byte3 & 0x3f];
  }
  return out;
}

/**
 * SHA-256 of a byte array, lowercase hex — the object id git-LFS addresses a
 * blob by.
 *
 * @param bytes - The bytes to hash
 * @returns The hex digest
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Passed as the view itself, not a slice of its backing store: a Uint8Array
  // is a BufferSource carrying its own byteOffset/byteLength, so only the range
  // this view covers is hashed. Slicing first would be a second full copy of
  // the file, on a path that already holds one.
  //
  // The cast is needed because `BufferSource` admits only ArrayBuffer-backed
  // views, while `Uint8Array` is generic over `ArrayBufferLike` and so might in
  // principle be backed by a SharedArrayBuffer. Upload payloads here are built
  // from `file.arrayBuffer()` and `readFile`, neither of which produces one.
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What `preupload` decided for one file. */
interface PreuploadDecision {
  path: string;
  uploadMode: "lfs" | "regular";
  shouldIgnore: boolean;
}

/**
 * Asks the Hub how each file should be uploaded.
 *
 * The answer is not guessable client-side: it depends on the repo's
 * `.gitattributes` (which puts `*.tif`, `*.parquet`, `*.pmtiles` and friends
 * into LFS) plus size and content heuristics. A sample of the first bytes is
 * sent so the Hub can tell text from binary.
 */
async function preuploadFiles(
  repoId: string,
  revision: string,
  files: HfUploadFile[],
  options: HfClientOptions,
): Promise<Map<string, PreuploadDecision>> {
  const { body } = await requestJson(
    `${resolveEndpoint(options)}/datasets/${encodeRepoId(repoId)}/preupload/${encodeURIComponent(revision)}`,
    options,
    jsonInit("POST", {
      files: files.map((file) => ({
        path: file.path,
        size: file.content.byteLength,
        sample: bytesToBase64(file.content.subarray(0, PREUPLOAD_SAMPLE_BYTES)),
      })),
    }),
  );

  const decisions = new Map<string, PreuploadDecision>();
  const rawFiles = asRecord(body).files;
  for (const raw of Array.isArray(rawFiles) ? rawFiles : []) {
    const record = asRecord(raw);
    const path = asString(record.path);
    if (!path) continue;
    decisions.set(path, {
      path,
      uploadMode: record.uploadMode === "lfs" ? "lfs" : "regular",
      shouldIgnore: record.shouldIgnore === true,
    });
  }
  return decisions;
}

/** Where one LFS blob should be PUT, or null when the Hub already has it. */
interface LfsUploadTarget {
  href: string;
  headers: Record<string, string>;
}

/**
 * Registers LFS blobs and returns where to PUT each one.
 *
 * Note this is *not* under `/api`: the LFS batch endpoint lives on the repo's
 * git URL, and it speaks the git-LFS media type rather than plain JSON. Only
 * `basic` transfer is requested, so each object comes back as a single PUT
 * target (see {@link HF_MAX_UPLOAD_BYTES}). An object the Hub already stores
 * comes back with no `actions`, which is the dedup path — re-uploading an
 * unchanged file costs nothing.
 */
async function requestLfsUploads(
  repoId: string,
  revision: string,
  objects: { oid: string; size: number }[],
  options: HfClientOptions,
): Promise<Map<string, LfsUploadTarget | null>> {
  const { body } = await requestJson(
    `${HF_SITE}/datasets/${encodeRepoId(repoId)}.git/info/lfs/objects/batch`,
    options,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.git-lfs+json",
        "Content-Type": "application/vnd.git-lfs+json",
      },
      body: JSON.stringify({
        operation: "upload",
        transfers: ["basic"],
        hash_algo: "sha_256",
        ref: { name: revision },
        objects,
      }),
    },
  );

  const targets = new Map<string, LfsUploadTarget | null>();
  const rawObjects = asRecord(body).objects;
  for (const raw of Array.isArray(rawObjects) ? rawObjects : []) {
    const record = asRecord(raw);
    const oid = asString(record.oid);
    if (!oid) continue;
    const error = asRecord(record.error);
    if (asString(error.message)) {
      throw new Error(asString(error.message));
    }
    const upload = asRecord(asRecord(record.actions).upload);
    const href = asString(upload.href);
    if (!href) {
      // Already stored — nothing to PUT, but the commit still references it.
      targets.set(oid, null);
      continue;
    }
    const rawHeaders = asRecord(upload.header);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value === "string") headers[key] = value;
    }
    targets.set(oid, { href, headers });
  }
  return targets;
}

/**
 * Uploads files into a dataset repo as one commit.
 *
 * The sequence is fixed by the Hub's API and each step depends on the last:
 * ask how each file travels (`preupload`), hash and stage the LFS ones through
 * the LFS batch endpoint and their storage URLs, then commit — inlining the
 * small files as base64 and referencing the LFS ones by hash. Everything lands
 * in a single commit, so a failure part-way leaves the repo untouched rather
 * than half-populated.
 *
 * @param spec - The destination and the files
 * @param options - Client options; `token` is required
 * @returns The commit's URL when the Hub reports one
 */
export async function uploadDatasetFiles(
  spec: {
    repoId: string;
    files: HfUploadFile[];
    revision?: string;
    commitMessage?: string;
    commitDescription?: string;
    onProgress?: (progress: HfUploadProgress) => void;
  },
  options: HfClientOptions,
): Promise<{ commitUrl: string | null }> {
  if (!options.token) throw new Error("A Hugging Face access token is required.");
  if (spec.files.length === 0) throw new Error("Select at least one file to upload.");

  const revision = spec.revision ?? HF_DEFAULT_REVISION;
  const total = spec.files.length;
  const report = (phase: HfUploadProgress["phase"], path: string, index: number) =>
    spec.onProgress?.({ phase, path, index, total });

  report("preparing", "", 0);
  const decisions = await preuploadFiles(spec.repoId, revision, spec.files, options);

  // `shouldIgnore` marks a path the repo's .gitignore excludes: committing it
  // would be rejected, so it is dropped here with the rest still going through.
  const staged = spec.files.filter((file) => !decisions.get(file.path)?.shouldIgnore);
  if (staged.length === 0) {
    throw new Error("Every selected file is ignored by this dataset repo.");
  }

  // Hash first, in one pass, so the LFS registration below is a single batch
  // request for every blob rather than one round trip per file.
  const lfsFiles: { file: HfUploadFile; oid: string }[] = [];
  for (const [index, file] of staged.entries()) {
    if (decisions.get(file.path)?.uploadMode !== "lfs") continue;
    report("hashing", file.path, index + 1);
    lfsFiles.push({ file, oid: await sha256Hex(file.content) });
  }

  if (lfsFiles.length > 0) {
    const targets = await requestLfsUploads(
      spec.repoId,
      revision,
      lfsFiles.map(({ file, oid }) => ({ oid, size: file.content.byteLength })),
      options,
    );
    for (const [index, { file, oid }] of lfsFiles.entries()) {
      const target = targets.get(oid);
      // Absent from the response, or present with no upload action: the Hub
      // already stores this blob. Either way there is nothing to send.
      if (!target) continue;
      report("uploading", file.path, index + 1);
      // Deliberately not via `request`: the storage URL is pre-signed and on a
      // different host, so it must NOT receive the Hub bearer token — sending
      // it there both leaks the token and can be rejected as a bad signature.
      const fetchImpl = options.fetchImpl ?? defaultFetch;
      const response = await fetchImpl(target.href, {
        method: "PUT",
        headers: target.headers,
        body: file.content,
        signal: options.signal,
      });
      if (!response.ok) {
        throw errorFromBody(await response.text(), response.status);
      }
    }
  }

  report("committing", "", total);
  const lfsByPath = new Map(lfsFiles.map(({ file, oid }) => [file.path, oid]));
  const lines: string[] = [
    JSON.stringify({
      key: "header",
      value: {
        summary: spec.commitMessage?.trim() || `Upload ${staged.length} file(s) with GeoLibre`,
        ...(spec.commitDescription ? { description: spec.commitDescription } : {}),
      },
    }),
  ];
  for (const file of staged) {
    const oid = lfsByPath.get(file.path);
    lines.push(
      oid
        ? JSON.stringify({
            key: "lfsFile",
            value: { path: file.path, algo: "sha256", oid, size: file.content.byteLength },
          })
        : JSON.stringify({
            key: "file",
            value: { path: file.path, encoding: "base64", content: bytesToBase64(file.content) },
          }),
    );
  }

  const { body } = await requestJson(
    `${resolveEndpoint(options)}/datasets/${encodeRepoId(spec.repoId)}/commit/${encodeURIComponent(revision)}`,
    options,
    {
      method: "POST",
      // NDJSON, one operation per line — the commit API's own format.
      headers: { "Content-Type": "application/x-ndjson" },
      body: `${lines.join("\n")}\n`,
    },
  );
  return { commitUrl: asString(asRecord(body).commitUrl) || null };
}
