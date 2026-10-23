import { isAndroid } from "./is-mobile";

export interface FileDialogFilter {
  name: string;
  extensions: string[];
}

/**
 * Select native file-dialog filters for the current platform.
 *
 * Android's document picker filters by MIME type and cannot reliably map
 * uncommon filename extensions. Callers can therefore provide a separate
 * Android filter set while retaining precise extension filters on desktop and
 * iOS.
 *
 * @param filters - Default file filters used outside Android.
 * @param androidFilters - Android-specific filters, when required.
 * @param userAgent - Override for testing; defaults to `navigator.userAgent`.
 * @returns The filters appropriate for the current platform.
 */
export function nativeFileDialogFilters(
  filters: FileDialogFilter[],
  androidFilters: FileDialogFilter[] | undefined,
  userAgent: string = typeof navigator !== "undefined" ? navigator.userAgent : "",
): FileDialogFilter[] {
  return isAndroid(userAgent) && androidFilters !== undefined ? androidFilters : filters;
}
