/**
 * Translated text for offline edit outbox errors (#3530). Adapters have no
 * translator, so they attach a code to the errors a user must act on (or
 * wait out); this maps those codes to catalog messages.
 */

import type { TFunction } from "i18next";

/**
 * The translated message for an outbox error code, or the source's own
 * message when the code is unknown or missing.
 *
 * @param code The error code (`EditSyncError.code` / `lastErrorCode`).
 * @param fallback The raw message.
 * @param t Translator.
 * @returns Display text.
 */
export function describeSyncError(
  code: string | undefined,
  fallback: string | undefined,
  t: TFunction,
): string {
  switch (code) {
    case "postgisNoConnection":
      return t("editOutbox.errors.postgisNoConnection");
    case "arcgisLayerClosed":
      return t("editOutbox.errors.arcgisLayerClosed");
    case "geolensNotConnected":
      return t("editOutbox.errors.geolensNotConnected");
    default:
      return fallback ?? "";
  }
}
