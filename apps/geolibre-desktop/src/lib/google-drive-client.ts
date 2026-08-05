/**
 * Fetching Google Drive items into browser `File` objects.
 *
 * Once a Drive file's bytes are a `File`, the rest of GeoLibre already knows
 * what to do with it: `loadDroppedVectorFiles` classifies by extension, unzips
 * shapefile archives, pairs a `.shp` with its sidecars, and routes everything
 * else through DuckDB. So this module's only job is to get the bytes and the
 * *name* — the name matters as much as the bytes, because it is what that
 * classification runs on.
 *
 * Two transports, chosen by build:
 *
 *  - **Desktop** fetches through Tauri's native HTTP client, which is not
 *    subject to the WebView's CORS enforcement. That unlocks Drive's public
 *    download host, which serves an "anyone with the link" file with no
 *    credential at all — the common case, working out of the box.
 *  - **Web** must use `www.googleapis.com/drive/v3`, the one Drive endpoint
 *    that sends CORS headers. It always needs a credential (an API key for a
 *    public file, an OAuth token for a private one).
 *
 * The hosts used here must stay listed in the `http:default` capability scope
 * (`src-tauri/capabilities/default.json`) or the desktop transport is refused.
 */

import { isTauri } from "./is-tauri";
import {
  DRIVE_FOLDER_MIME_TYPE,
  DriveError,
  driveErrorCode,
  driveFolderChildrenUrl,
  driveMediaUrl,
  driveMetadataUrl,
  drivePublicDownloadUrl,
  fileNameFromContentDisposition,
  isWorkspaceDocument,
  type DriveCredentials,
  type DriveFile,
} from "./google-drive";

/**
 * Fetch that bypasses the WebView's CORS enforcement on desktop. Resolved per
 * call (not cached at module load) so the dynamic import stays out of the web
 * and embedded bundles entirely.
 */
async function driveFetch(url: string, credentials: DriveCredentials): Promise<Response> {
  const headers: Record<string, string> = {};
  if (credentials.accessToken) headers.Authorization = `Bearer ${credentials.accessToken}`;

  if (isTauri()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(url, { headers });
  }
  return fetch(url, { headers });
}

/** Throws the coded error for a failed response, or returns it unchanged. */
function assertOk(response: Response): Response {
  if (!response.ok) throw new DriveError(driveErrorCode(response.status));
  return response;
}

/**
 * Whether the credentials can reach Drive's REST API at all. The public
 * download host needs none, but it is desktop-only, so a web build with neither
 * a key nor a token has no usable transport and should say so up front rather
 * than issuing a request that is certain to 401.
 *
 * @param credentials - The credential to check
 * @returns True when a Drive request can be made
 */
export function canReachDrive(credentials: DriveCredentials): boolean {
  return Boolean(credentials.accessToken || credentials.apiKey) || isTauri();
}

/**
 * Reads an item's metadata.
 *
 * Requires a credential — the public download host has no metadata endpoint —
 * so the desktop credential-free path skips this and takes the name from the
 * download's `Content-Disposition` instead.
 *
 * @param id - The Drive file or folder id
 * @param credentials - API key or OAuth token
 * @returns The item's id, name, MIME type and size
 * @throws DriveError when Drive refuses the request
 */
export async function fetchDriveMetadata(
  id: string,
  credentials: DriveCredentials,
): Promise<DriveFile> {
  const response = assertOk(await driveFetch(driveMetadataUrl(id, credentials), credentials));
  const body = (await response.json()) as {
    id: string;
    name: string;
    mimeType: string;
    size?: string;
  };
  return {
    id: body.id,
    name: body.name,
    mimeType: body.mimeType,
    // Drive sends size as a string (it can exceed 2^53); the values GeoLibre
    // can actually open are far below that, so a Number is safe here.
    size: body.size === undefined ? undefined : Number(body.size),
  };
}

/**
 * Lists a folder's immediate children, following Drive's paging.
 *
 * Capped rather than unbounded: a shared Drive folder can hold tens of
 * thousands of items, and the caller renders every entry as a row. The cap is
 * on *pages* walked, so the returned list is a prefix of the folder in Drive's
 * own order (folders first, then by name) rather than an arbitrary subset.
 *
 * @param folderId - The Drive folder id
 * @param credentials - API key or OAuth token
 * @param maxPages - How many 1000-item pages to walk at most
 * @returns The children found
 * @throws DriveError when Drive refuses the request
 */
export async function listDriveFolder(
  folderId: string,
  credentials: DriveCredentials,
  maxPages = 3,
): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const response = assertOk(
      await driveFetch(driveFolderChildrenUrl(folderId, credentials, pageToken), credentials),
    );
    const body = (await response.json()) as {
      nextPageToken?: string;
      files?: { id: string; name: string; mimeType: string; size?: string }[];
    };
    for (const file of body.files ?? []) {
      files.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size === undefined ? undefined : Number(file.size),
      });
    }
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }

  return files;
}

/**
 * Downloads a Drive file's bytes as a browser `File`.
 *
 * `fallbackName` is used only when the name is not already known and Drive's
 * `Content-Disposition` carries none. It matters because the vector loader
 * classifies by extension: a file that arrives named `download` is not a
 * shapefile as far as the rest of the app is concerned, however valid its
 * bytes.
 *
 * @param file - The item to download; `name` is used verbatim when set
 * @param credentials - API key or OAuth token (both optional on desktop)
 * @param fallbackName - Name to use when neither source supplies one
 * @returns The downloaded file
 * @throws DriveError for a Google-native document, a folder, or a refused request
 */
export async function downloadDriveFile(
  file: Pick<DriveFile, "id"> & Partial<Pick<DriveFile, "name" | "mimeType">>,
  credentials: DriveCredentials,
  fallbackName = "google-drive-download",
): Promise<File> {
  if (file.mimeType && isWorkspaceDocument(file.mimeType)) {
    throw new DriveError("workspaceDocument");
  }
  // A `?id=` link carries no hint of whether it names a file or a folder, so
  // `parseDriveTarget` calls it a file and a folder can arrive here. Asking for
  // `alt=media` on one fails with a status that maps to the generic
  // "requestFailed", which says nothing about the actual problem.
  if (file.mimeType === DRIVE_FOLDER_MIME_TYPE) {
    throw new DriveError("folderLink");
  }

  // Desktop with no credential at all: the public host is the only endpoint
  // that serves bytes without one, and native HTTP makes its missing CORS
  // headers irrelevant.
  const credentialFree = !credentials.accessToken && !credentials.apiKey;
  const url =
    credentialFree && isTauri()
      ? drivePublicDownloadUrl(file.id)
      : driveMediaUrl(file.id, credentials);

  const response = assertOk(await driveFetch(url, credentials));
  const blob = await response.blob();

  // The public host answers a private file with a 200 HTML sign-in page rather
  // than a 4xx, so status alone cannot be trusted there. Catching it here turns
  // an unreadable "invalid shapefile" deep in the loader into the real problem.
  if (credentialFree && blob.type.startsWith("text/html")) {
    throw new DriveError("forbidden");
  }

  const name =
    file.name ||
    fileNameFromContentDisposition(response.headers.get("content-disposition")) ||
    fallbackName;
  return new File([blob], name, {
    type: blob.type || "application/octet-stream",
  });
}
