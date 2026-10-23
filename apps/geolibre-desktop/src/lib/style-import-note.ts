/**
 * Turning what `importStyleText` returned into something to show.
 *
 * Both doors into a style import — the Layers panel's row status and the Style panel's header
 * note — report the same outcomes, and the paste dialog picks the same error text. Kept in one
 * place so a warning that stops being appended stops being appended everywhere at once, rather
 * than in whichever copy somebody remembered.
 */

import type { TFunction } from "i18next";
import type { ImportedStyleError } from "@geolibre/map/style-import";

/**
 * How long a note stays on screen.
 *
 * Mirrors `REFRESH_STATUS_DURATION_MS` in the Layers panel, which fades the row status. Both doors
 * report the same outcomes, so both report them for the same length of time.
 */
export const IMPORTED_STYLE_NOTE_DURATION_MS = 4_000;

export interface ImportedStyleNote {
  type: "success" | "warning";
  message: string;
}

/**
 * A successful import, and whatever the parser could not represent.
 *
 * Warnings are appended rather than dropped: they are the reader saying what it left behind, and a
 * bare "Style imported." over a half-imported style is the failure this reporting exists to
 * prevent.
 */
export function importedStyleNote(t: TFunction, warnings: string[]): ImportedStyleNote {
  return warnings.length > 0
    ? { type: "warning", message: `${t("layers.importStyleSuccess")} ${warnings.join(" ")}` }
    : { type: "success", message: t("layers.importStyleSuccess") };
}

/**
 * Why an import produced nothing.
 *
 * A `no-match` usually carries the parser's own account, which says more than the generic string;
 * only the first is shown, because every surface for this is a single line. The rest stay on the
 * result for a caller that has room for them.
 */
export function importedStyleErrorMessage(t: TFunction, error: ImportedStyleError): string {
  if (error.reason === "invalid") return t("layers.importStyleInvalid");
  return error.warnings[0] ?? t("layers.importStyleNoMatch");
}
