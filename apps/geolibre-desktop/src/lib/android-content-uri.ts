// Helpers for the Android Storage Access Framework `content://` URIs that the
// native document picker returns in place of a filesystem path. Kept in their
// own module (free of Tauri/React imports) so they can be unit-tested in Node.
//
// Android hands back two kinds of URI and only one of them is writable.
// `tauri-plugin-dialog`'s `open()` launches `ACTION_GET_CONTENT`, whose grant is
// read-only and cannot be upgraded from inside the app; writing to it is refused
// with "Permission Denial: ... requires android.permission.MANAGE_DOCUMENTS, or
// grantUriPermission()" (GeoLibre#1833). Its `save()` launches
// `ACTION_CREATE_DOCUMENT`, whose grant does include write. So a project opened
// from device storage reads and edits fine but cannot be saved back in place,
// while one created through the save dialog can.
//
// Nothing in the URI itself says which grant it carries, so callers attempt the
// write and use `isUriWritePermissionError` to tell "this URI is read-only"
// apart from a genuine I/O failure.

/**
 * Whether a path is an Android SAF content URI rather than a filesystem path.
 *
 * @param path - The stored project path (a filesystem path, an HTTP URL, or a
 *   `content://` URI on Android).
 * @returns True for a `content://` URI.
 */
export function isAndroidContentUri(path: string): boolean {
  return /^content:\/\//i.test(path);
}

/**
 * Recover the original file name from an Android SAF content URI, so a save
 * dialog opened as a fallback can be pre-filled with the name the user already
 * knows instead of a generic default.
 *
 * The document id is provider-defined and percent-encoded in the last URI
 * segment: `ExternalStorageProvider` uses a path-like
 * `primary:Documents/json/Project.geolibre.json`, while the Downloads provider
 * uses opaque ids such as `msf:1000000123`. Only a segment that still looks like
 * a file name (it carries an extension) is usable, so an opaque id yields null
 * and the caller falls back to a project-derived name.
 *
 * @param uri - The content URI to inspect.
 * @returns The file name, or null when the URI carries no usable one.
 */
export function androidContentUriFileName(uri: string): string | null {
  if (!isAndroidContentUri(uri)) return null;
  const withoutQuery = uri.split(/[?#]/)[0];
  const lastSegment = withoutQuery.split("/").pop() ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(lastSegment);
  } catch {
    // A malformed escape sequence makes the whole segment undecodable; fall
    // back to the raw text rather than losing the name entirely.
    decoded = lastSegment;
  }
  const name = (decoded.split(/[/:]/).pop() ?? "").trim();
  return /\.[A-Za-z0-9]+$/.test(name) ? name : null;
}

/**
 * Android permission refusals reaching the webview as message text.
 *
 * Matched by text because there is no typed signal: the failure originates in
 * Android's `ContentResolver` and crosses the Tauri bridge as a plain string
 * ("failed to open file: Permission Denial: writing ... uri content://... from
 * pid=7564, uid=10393 requires android.permission.MANAGE_DOCUMENTS, or
 * grantUriPermission()"). The POSIX codes cover the same refusal surfacing from
 * the Rust side rather than the Java one.
 *
 * Deliberately narrow: a real write failure (no space left, a provider that has
 * gone away) must keep propagating as an error rather than quietly reopening a
 * save dialog.
 */
const URI_WRITE_PERMISSION_PATTERN =
  /permission denial|permission denied|granturipermission|manage_documents|no permission|\beacces\b|\beperm\b|read-only file system/i;

/**
 * Whether a write failure was Android refusing the URI's grant, rather than an
 * ordinary I/O error.
 *
 * @param error - The value thrown by the write attempt.
 * @returns True when the message reads as a permission refusal.
 */
export function isUriWritePermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return URI_WRITE_PERMISSION_PATTERN.test(message);
}

/** The two I/O calls {@link writeInPlaceWithAndroidFallback} needs. */
export interface InPlaceWriteHandlers {
  /** Write the content to an already-known path. Rejects if it cannot. */
  write: (path: string, content: string) => Promise<void>;
  /** Open the native save dialog and write there. Null if cancelled. */
  saveAs: (content: string, defaultName?: string) => Promise<string | null>;
}

/**
 * Write to an already-known path, falling back to the save dialog when Android
 * refuses a read-only `content://` grant (GeoLibre#1833).
 *
 * The handlers are injected so the fallback rule can be tested without mocking
 * the Tauri modules: this is the behaviour that keeps Save working on Android,
 * so a dependency bump that changes how a refusal is reported should fail a
 * test rather than silently drop the user back to a broken Save.
 *
 * Falling back is safe because Android rejects the request when the output
 * stream is opened, before the document is truncated, so a refused write leaves
 * the original file untouched.
 *
 * @param content - The text to write.
 * @param path - The path or content URI the file was opened from.
 * @param fallbackName - Save-dialog file name, used only when the path carries
 *   no usable name of its own.
 * @param handlers - The write and save-as implementations.
 * @returns The path actually written, or null if a fallback dialog was
 *   cancelled.
 */
export async function writeInPlaceWithAndroidFallback(
  content: string,
  path: string,
  fallbackName: string | undefined,
  handlers: InPlaceWriteHandlers,
): Promise<string | null> {
  try {
    await handlers.write(path, content);
  } catch (error) {
    if (isAndroidContentUri(path) && isUriWritePermissionError(error)) {
      // The refusal is matched by wording, and OEM storage providers phrase
      // their failures differently, so a provider could in principle report an
      // unrelated error that reads like a permission denial and land here. That
      // shows up as an unexplained "why is it asking me to save again?", so
      // record the original error: `console.warn` is captured by the
      // Diagnostics panel, which is where a user reporting this would look.
      console.warn(`Falling back to the save dialog; cannot write ${path} in place`, error);
      return handlers.saveAs(content, androidContentUriFileName(path) ?? fallbackName);
    }
    throw error;
  }
  return path;
}
