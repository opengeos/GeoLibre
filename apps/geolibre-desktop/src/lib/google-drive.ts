/**
 * Turning a Google Drive link into something GeoLibre can download.
 *
 * The Add Data → Google Drive source accepts whatever the user has in their
 * clipboard — a "Share" link, a browser address bar URL, or a bare file ID —
 * and has to answer the same questions every time: which file (or folder) does
 * this point at, which endpoint serves its bytes given the credentials we have,
 * and which of a folder's entries are worth downloading. Those are facts about
 * Drive's URL shapes and REST API, not about the dialog, so they live here and
 * stay DOM-, i18n- and framework-free (unit tested under `node --test`).
 *
 * Errors are returned as codes rather than sentences for the same reason: the
 * component owns the wording so this module never imports i18n.
 */

/** Drive's own MIME type for a folder. */
export const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

/** Base of the Drive REST API v3 — CORS-enabled, so the web build can use it. */
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3/files";

/**
 * The public download host. Unlike {@link DRIVE_API_BASE} it needs no
 * credential for an "anyone with the link" file, but it sends no CORS headers,
 * so only the desktop build (which fetches through Tauri's native HTTP client)
 * can use it. See `google-drive-client.ts`.
 */
const DRIVE_PUBLIC_DOWNLOAD_BASE = "https://drive.usercontent.google.com/download";

/** What a pasted link resolves to. */
export interface DriveTarget {
  kind: "file" | "folder";
  id: string;
}

/** A Drive item as returned by the REST API (the subset GeoLibre asks for). */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** Bytes, absent for Google-native documents which have no binary size. */
  size?: number;
}

/**
 * Why a Drive request could not be turned into a layer. The component maps
 * these to `t()` keys; keeping them as codes keeps this module i18n-free.
 */
export type DriveErrorCode =
  /** The pasted text held no recognizable file or folder id. */
  | "unrecognizedLink"
  /** Drive refused the request: the file is private and we have no token. */
  | "forbidden"
  /** No such file, or the signed-in account cannot see it. */
  | "notFound"
  /** The credential (API key or access token) was rejected. */
  | "unauthorized"
  /** Drive answered, but with something other than the file's bytes. */
  | "requestFailed"
  /** A Docs/Sheets/Slides document, which has no geospatial bytes to download. */
  | "workspaceDocument"
  /** The folder held nothing GeoLibre knows how to read. */
  | "emptyFolder";

/** Thrown by the client for a failure the dialog should phrase itself. */
export class DriveError extends Error {
  readonly code: DriveErrorCode;

  constructor(code: DriveErrorCode, message?: string) {
    super(message ?? code);
    this.name = "DriveError";
    this.code = code;
  }
}

/**
 * A Drive id as it appears in a URL. Drive ids are base64url-ish and vary in
 * length by item age (28 characters is typical today, 19 for very old files),
 * so the bound is deliberately loose — the API is the real validator. The lower
 * bound exists only to stop a stray word like "folders" being read as an id.
 */
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{12,}$/;

/**
 * The link shapes Drive hands out, most specific first. Each captures the id in
 * group 1. Order matters only in that `/folders/` must be tested before the
 * generic `/d/<id>` rule, which would otherwise not match it anyway — they are
 * kept adjacent so that stays visible.
 */
const LINK_PATTERNS: readonly { pattern: RegExp; kind: DriveTarget["kind"] }[] = [
  // https://drive.google.com/drive/folders/<id>?usp=sharing
  // https://drive.google.com/drive/u/0/folders/<id>
  { pattern: /\/folders\/([A-Za-z0-9_-]+)/, kind: "folder" },
  // https://drive.google.com/file/d/<id>/view
  // https://docs.google.com/spreadsheets/d/<id>/edit
  { pattern: /\/d\/([A-Za-z0-9_-]+)/, kind: "file" },
  // https://drive.google.com/open?id=<id>
  // https://drive.google.com/uc?export=download&id=<id>
  // https://drive.usercontent.google.com/download?id=<id>&export=download
  { pattern: /[?&]id=([A-Za-z0-9_-]+)/, kind: "file" },
];

/**
 * Resolves pasted text to the Drive item it names.
 *
 * Accepts every link Drive's own "Copy link" and address bar produce, plus a
 * bare id pasted on its own — people routinely copy just the id out of a URL,
 * and rejecting that would be a puzzle with no clue in the error message.
 *
 * @param input - A Drive URL or a bare file/folder id
 * @returns The target, or null when nothing id-shaped was found
 */
export function parseDriveTarget(input: string): DriveTarget | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  for (const { pattern, kind } of LINK_PATTERNS) {
    const match = pattern.exec(trimmed);
    // Re-check the captured text against the id shape: `/d/edit` in a malformed
    // paste matches the pattern but is not an id.
    if (match && DRIVE_ID_PATTERN.test(match[1])) {
      return { kind, id: match[1] };
    }
  }

  // A bare id — but only when the text is *only* that, so a URL whose patterns
  // all failed reports "unrecognized" rather than being read as an id.
  if (DRIVE_ID_PATTERN.test(trimmed)) return { kind: "file", id: trimmed };

  return null;
}

/**
 * Whether a MIME type is a Google-native document (Docs, Sheets, Slides, Forms,
 * …). These are editor documents with no stored bytes, so `alt=media` fails on
 * them; GeoLibre reports them rather than downloading an export nobody asked
 * for. The folder MIME type shares the prefix and is excluded — a folder is a
 * container the caller handles, not a dead end.
 *
 * @param mimeType - The item's MIME type
 * @returns True when the item is a Google-native document
 */
export function isWorkspaceDocument(mimeType: string): boolean {
  return mimeType.startsWith("application/vnd.google-apps.") && mimeType !== DRIVE_FOLDER_MIME_TYPE;
}

/** Query parameters every Drive call carries, so shared drives resolve too. */
function baseParams(credentials: DriveCredentials): URLSearchParams {
  const params = new URLSearchParams({ supportsAllDrives: "true" });
  // The key rides in the query string; the token rides in an Authorization
  // header (added by the client), so only the key appears here.
  if (!credentials.accessToken && credentials.apiKey) params.set("key", credentials.apiKey);
  return params;
}

/** How a Drive request authenticates. Both may be absent on the desktop build. */
export interface DriveCredentials {
  /** OAuth access token, from sign-in or the Picker. Preferred when present. */
  accessToken?: string;
  /** API key, for a file shared "anyone with the link". */
  apiKey?: string;
}

/**
 * URL for an item's metadata (name, size, MIME type) — the call that gives a
 * downloaded blob its file name, which is what the vector loader classifies on.
 *
 * @param id - The Drive file or folder id
 * @param credentials - The credential to authenticate with
 * @returns The absolute request URL
 */
export function driveMetadataUrl(id: string, credentials: DriveCredentials): string {
  const params = baseParams(credentials);
  params.set("fields", "id,name,mimeType,size");
  return `${DRIVE_API_BASE}/${encodeURIComponent(id)}?${params}`;
}

/**
 * URL for an item's bytes through the REST API. CORS-enabled, so this is the
 * only download endpoint the web build can use.
 *
 * @param id - The Drive file id
 * @param credentials - The credential to authenticate with
 * @returns The absolute request URL
 */
export function driveMediaUrl(id: string, credentials: DriveCredentials): string {
  const params = baseParams(credentials);
  params.set("alt", "media");
  return `${DRIVE_API_BASE}/${encodeURIComponent(id)}?${params}`;
}

/**
 * URL for a folder's immediate children.
 *
 * Trashed items are excluded server-side: a shared folder often has deleted
 * files still listed against it, and offering them would produce downloads that
 * fail. Ordered folders-first then by name so the picker list reads like Drive.
 *
 * @param folderId - The Drive folder id
 * @param credentials - The credential to authenticate with
 * @param pageToken - Continuation token from a previous page
 * @returns The absolute request URL
 */
export function driveFolderChildrenUrl(
  folderId: string,
  credentials: DriveCredentials,
  pageToken?: string,
): string {
  const params = baseParams(credentials);
  params.set("q", `'${folderId}' in parents and trashed = false`);
  params.set("fields", "nextPageToken,files(id,name,mimeType,size)");
  params.set("pageSize", "1000");
  params.set("orderBy", "folder,name");
  params.set("includeItemsFromAllDrives", "true");
  if (pageToken) params.set("pageToken", pageToken);
  return `${DRIVE_API_BASE}?${params}`;
}

/**
 * URL for the credential-free public download host.
 *
 * `confirm=t` skips the "Google Drive can't scan this file for viruses"
 * interstitial, which Drive serves as an HTML page in place of the bytes for
 * anything over ~100 MB. Without it a large shapefile silently downloads as a
 * few kilobytes of HTML and fails deep inside the vector loader with a parse
 * error that names neither Drive nor the interstitial.
 *
 * Only usable where browser CORS does not apply (the desktop build's native
 * HTTP client); see `google-drive-client.ts`.
 *
 * @param id - The Drive file id
 * @returns The absolute download URL
 */
export function drivePublicDownloadUrl(id: string): string {
  const params = new URLSearchParams({ id, export: "download", confirm: "t" });
  return `${DRIVE_PUBLIC_DOWNLOAD_BASE}?${params}`;
}

/**
 * Maps an HTTP status from Drive to the code the dialog phrases.
 *
 * 403 is split from 401 deliberately: 401 means the credential itself was
 * rejected (expired token, bad key), while 403 on Drive overwhelmingly means
 * the file exists but is not shared with the caller — two different fixes, and
 * the second is the one users hit constantly ("it works for me" links).
 *
 * @param status - The HTTP status code
 * @returns The matching error code
 */
export function driveErrorCode(status: number): DriveErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  return "requestFailed";
}

/**
 * The file name Drive reports in a `Content-Disposition` header.
 *
 * Needed only on the credential-free desktop path: without an API key there is
 * no metadata call, so the header is the one place the real name (and with it
 * the extension the vector loader classifies on) appears. Prefers the RFC 5987
 * `filename*` form, which is what Drive sends for non-ASCII names — a Thai or
 * Japanese file name arrives mojibake'd in the plain `filename` parameter.
 *
 * @param header - The raw `Content-Disposition` value, or null
 * @returns The decoded file name, or null when the header carries none
 */
export function fileNameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;

  const extended = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim()) || null;
    } catch {
      // A malformed percent-escape: fall through to the plain parameter rather
      // than failing the whole download over a header.
    }
  }

  const plain = /filename="?([^";]+)"?/.exec(header);
  return plain ? plain[1].trim() || null : null;
}

/**
 * Extensions the shapefile loader needs alongside a `.shp`. Mirrors
 * `SHAPEFILE_SIDECAR_EXTENSIONS` in `tauri-io.ts`, which is module-private
 * there; the two are checked against each other by `tests/google-drive.test.ts`
 * so this copy cannot drift into dropping a component the loader wants.
 */
export const SHAPEFILE_SIDECAR_EXTENSIONS = ["dbf", "shx", "prj", "cpg"] as const;

/** Lowercased extension of a file name, or "" when it has none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** File name without its extension, lowercased for sidecar matching. */
function baseNameOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot === -1 ? name : name.slice(0, dot)).toLowerCase();
}

/**
 * The folder entries GeoLibre offers to add, and which of them are sidecars.
 *
 * A shapefile is not one file, which is the whole reason a *folder* link is
 * worth supporting: an unzipped shapefile in Drive is a `.shp` next to its
 * `.dbf`/`.shx`/`.prj`. Those sidecars are not layers of their own, so they are
 * never listed as choices — but selecting the `.shp` has to pull them along or
 * the load fails on a missing `.dbf`. Marking them here (rather than filtering
 * them out) lets the caller show a list of real layers while still knowing what
 * else to download.
 *
 * Sidecars whose `.shp` is absent are dropped entirely: a lone `.dbf` is not
 * something the user can add, and listing it would only offer a guaranteed
 * failure.
 *
 * @param files - A folder's immediate children
 * @param isAddable - Whether a file name is a format the loader accepts
 * @returns Addable entries with their sidecars attached, in listing order
 */
export function groupFolderVectorFiles(
  files: readonly DriveFile[],
  isAddable: (name: string) => boolean,
): { file: DriveFile; sidecars: DriveFile[] }[] {
  const sidecarsByBase = new Map<string, DriveFile[]>();
  for (const file of files) {
    if (!SHAPEFILE_SIDECAR_EXTENSIONS.includes(extensionOf(file.name) as never)) continue;
    const base = baseNameOf(file.name);
    sidecarsByBase.set(base, [...(sidecarsByBase.get(base) ?? []), file]);
  }

  return files
    .filter(
      (file) =>
        file.mimeType !== DRIVE_FOLDER_MIME_TYPE &&
        !SHAPEFILE_SIDECAR_EXTENSIONS.includes(extensionOf(file.name) as never) &&
        isAddable(file.name),
    )
    .map((file) => ({
      file,
      sidecars:
        extensionOf(file.name) === "shp" ? (sidecarsByBase.get(baseNameOf(file.name)) ?? []) : [],
    }));
}
