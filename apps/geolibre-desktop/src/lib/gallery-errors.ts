// Translate a coded gallery/transfer failure into a localized message.
//
// The share libraries are non-React and cannot call `t()`, so they throw codes
// (`GalleryError`, `ShareOAuthError`) and this module maps each to a catalog
// string. It lives beside them so both the Project Gallery and the transfer
// dialog share one definition.

import type { TFunction } from "i18next";
import { shareHostLabel } from "./share-geolibre";
import { GalleryError } from "./share-gallery";
import { ShareOAuthError, shareOAuthErrorKey } from "./share-oauth";

/**
 * Translate a gallery or transfer error into a localized message.
 *
 * `oauthSupported` names the OAuth session in the unauthorized case, since that
 * is the credential the web sign-in produced.
 */
export function galleryErrorMessage(error: unknown, t: TFunction, oauthSupported: boolean): string {
  if (error instanceof ShareOAuthError) return t(shareOAuthErrorKey(error.code));
  if (error instanceof GalleryError) {
    switch (error.code) {
      case "timeout":
        return t("gallery.errorTimeout");
      case "network":
        return t("gallery.errorNetwork", { shareHost: shareHostLabel() });
      case "invalid-response":
        return t("gallery.errorInvalidResponse");
      case "unauthorized":
        return oauthSupported
          ? t("gallery.errorUnauthorizedOAuth", { shareHost: shareHostLabel() })
          : t("gallery.errorUnauthorized", { shareHost: shareHostLabel() });
      case "username-required":
        return t("gallery.errorUsernameRequired", {
          shareHost: shareHostLabel(),
        });
      case "slug-conflict":
        return t("gallery.errorSlugConflict");
      case "transfer-pending":
        return t("gallery.errorTransferPending");
      case "transfer-invalid":
        return t("gallery.errorTransferInvalid");
      case "user-not-found":
        return t("gallery.errorUserNotFound");
      case "not-configured":
        return t("gallery.errorNotConfigured");
      case "http":
        return t("gallery.errorHttp", { status: error.status ?? 0 });
    }
  }
  return error instanceof Error ? error.message : t("gallery.errorFallback");
}
