// Shared parsing of the chrome query params, so the live layout
// (useLayoutOptions) and Export as HTML (html-export) read them the same way.

export const HIDDEN_PANEL_VALUES = new Set(["hidden", "hide", "none", "off"]);
const TRUTHY_FLAG_VALUES = new Set(["", "true", "1", "yes", "on"]);

/** A query param value trimmed and lowercased; `""` when absent. */
export function normalizedParam(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

/**
 * Whether the query asks for the map-only chrome. The param can be a bare
 * flag (`?maponly`) or an explicit truthy value (`?maponly=true`).
 */
export function isMapOnly(params: URLSearchParams): boolean {
  return params.has("maponly") && TRUTHY_FLAG_VALUES.has(normalizedParam(params.get("maponly")));
}

/**
 * Whether the query hides every side panel (`?maponly`, `?panels=hidden`,
 * `?hidePanels=true`).
 */
export function arePanelsHidden(params: URLSearchParams): boolean {
  return (
    isMapOnly(params) ||
    HIDDEN_PANEL_VALUES.has(normalizedParam(params.get("panels"))) ||
    normalizedParam(params.get("hidePanels")) === "true"
  );
}

/**
 * Whether the query opts a `layout=viewer` embed into drawing (`?draw`,
 * `?draw=true`). Only a flag: the caller decides whether the layout and the
 * deployment's capabilities let it take effect.
 */
export function isDrawRequested(params: URLSearchParams): boolean {
  return params.has("draw") && TRUTHY_FLAG_VALUES.has(normalizedParam(params.get("draw")));
}
