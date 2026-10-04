import i18next from "i18next";
import { notify } from "../notify";

/**
 * Tells the user a picked or dropped file was skipped because it could not be
 * read. The pickers keep going with the rest of the selection, so without this
 * the file would just be missing from the map.
 *
 * @param path - The file's path (only its base name is shown).
 * @param error - The read failure, shown as the description when it is an Error.
 */
export function notifyFileReadFailed(path: string, error: unknown): void {
  const name = path.split(/[\\/]/).pop() || path;
  notify.warning(i18next.t("notifications.fileReadFailed", { name }), {
    description: error instanceof Error ? error.message : undefined,
    dedupeKey: `file-read:${path}`,
  });
}
