import { WHITEBOX_MENU_CATALOG } from "./whitebox-menu-catalog";

/**
 * Query parameter that deep-links to a single Whitebox/Processing tool, e.g.
 * `…/?tool=adaptive_filter`. Opening the app with it preselects that tool in the
 * Processing (Whitebox toolbox) dialog. Mirrors the tool ids the Processing menu
 * uses (`ProcessingMenu.openWhiteboxTool`).
 */
export const WHITEBOX_TOOL_PARAM = "tool";

/**
 * App-level query parameters that keep their own meaning even when a `?tool=`
 * deep link is present, so they are **not** forwarded to the tool's parameter
 * form. Every other query parameter — including `url` — becomes a tool
 * parameter (the "tool mode wins" rule: with `?tool=` present, `url` names a
 * tool input, and the project-URL loader is suppressed; see
 * `projectUrlFromLocation`). Keep this list in sync with the embed/layout params
 * documented in `docs/user-guide/embedding.md`.
 */
const RESERVED_PARAMS: ReadonlySet<string> = new Set([
  WHITEBOX_TOOL_PARAM,
  // Embed chrome / layout.
  "layout",
  "embed",
  "iframe",
  "toolbar",
  "panels",
  "hidePanels",
  "maponly",
  "theme",
  "welcome",
  // i18n + collaboration.
  "locale",
  "lang",
  "collab",
]);

/**
 * Every tool id present in the checked-in Whitebox menu catalog — the Whitebox
 * catalog snapshot tools plus the GeoLibre-authored WASM tools. Built once at
 * module load and used to validate a `?tool=` deep link before it opens the
 * dialog. This is the union across engines; a given runtime (WASM in the
 * browser, the Python sidecar under Tauri) may not expose every one, which the
 * dialog's own async guard handles by ignoring an id absent from the *loaded*
 * tool list.
 */
const KNOWN_TOOL_IDS: ReadonlySet<string> = new Set(
  WHITEBOX_MENU_CATALOG.flatMap((category) =>
    category.subcategories.flatMap((subcategory) => subcategory.tools.map((tool) => tool.id)),
  ),
);

/**
 * Whether `toolId` matches a tool id in the Processing menu catalog.
 *
 * @param toolId - A candidate tool id.
 * @returns `true` when the catalog contains the id.
 */
export function isKnownWhiteboxToolId(toolId: string): boolean {
  return KNOWN_TOOL_IDS.has(toolId);
}

/** A `?tool=` deep-link target parsed from a query string. */
export interface WhiteboxToolUrlTarget {
  /** The trimmed `?tool=` value. */
  toolId: string;
  /** Whether {@link toolId} matches a catalog tool id. */
  known: boolean;
  /**
   * Tool parameter values parsed from the remaining (non-reserved) query
   * params, each kept as a string (the dialog stores every parameter value as a
   * string). First value wins for a repeated key. Empty when the deep link
   * carries no tool parameters. Only applied when {@link known} is `true`.
   */
  parameters: Record<string, string>;
}

/**
 * Parses a `?tool=` deep link from a raw query string.
 *
 * @param search - A `window.location.search`-style query string (leading `?`
 *   optional).
 * @returns The target, or `null` when the `tool` parameter is absent or empty.
 *   A present-but-unknown id is returned with `known: false` (and no
 *   parameters) rather than dropped, so the caller can still open the dialog and
 *   let the user pick.
 */
export function whiteboxToolFromSearch(search: string): WhiteboxToolUrlTarget | null {
  const params = new URLSearchParams(search);
  const toolId = params.get(WHITEBOX_TOOL_PARAM)?.trim() ?? "";
  if (!toolId) return null;

  const parameters: Record<string, string> = {};
  for (const [key, value] of params) {
    // First value wins for a repeated key; skip app-level params so, e.g.,
    // `theme` styles the app rather than becoming a phantom tool input.
    if (RESERVED_PARAMS.has(key) || key in parameters) continue;
    parameters[key] = value;
  }

  return { toolId, known: isKnownWhiteboxToolId(toolId), parameters };
}

/**
 * Reads a `?tool=` deep link from the current `window.location`, if one is
 * present. Returns `null` outside a browser (SSR/tests without a window) or
 * when the parameter is absent.
 *
 * @returns The parsed target, or `null`.
 */
export function whiteboxToolFromLocation(): WhiteboxToolUrlTarget | null {
  if (typeof window === "undefined") return null;
  return whiteboxToolFromSearch(window.location.search);
}

/**
 * Canonical public URL of the hosted web app, used as the base for a shareable
 * tool link from the **desktop** build — there `window.location` is a
 * `tauri://…` origin that recipients can't open. The web build shares its own
 * origin instead (see `whiteboxToolShareBase`).
 */
export const GEOLIBRE_WEB_APP_URL = "https://web.geolibre.app/";

/**
 * The base URL a "Copy link" share should build on.
 *
 * @param desktop - Whether the app is the desktop (Tauri) build, whose
 *   `window.location` is not shareable.
 * @returns `GEOLIBRE_WEB_APP_URL` on desktop; otherwise the current app's
 *   origin + path (so a self-hosted web deployment links to itself), falling
 *   back to the canonical URL when there is no window.
 */
export function whiteboxToolShareBase(desktop: boolean): string {
  if (desktop || typeof window === "undefined") return GEOLIBRE_WEB_APP_URL;
  return `${window.location.origin}${window.location.pathname}`;
}

/**
 * Builds a shareable `?tool=` deep link, the inverse of
 * {@link whiteboxToolFromSearch}: `<base>?tool=<toolId>` plus one query
 * parameter per entry in `parameters`. Any query string already on `base` is
 * dropped so the link is deterministic. The caller decides which parameters to
 * include (the dialog omits local file paths and values left at their default).
 *
 * @param toolId - The tool id to preselect.
 * @param parameters - Tool parameter values to prefill, each a string.
 * @param base - The base URL (see {@link whiteboxToolShareBase}).
 * @returns The absolute share URL.
 */
export function buildWhiteboxToolShareUrl(
  toolId: string,
  parameters: Record<string, string>,
  base: string,
): string {
  const url = new URL(base);
  url.search = "";
  url.hash = "";
  url.searchParams.set(WHITEBOX_TOOL_PARAM, toolId);
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
