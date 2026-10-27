import type { MapViewState } from "@geolibre/core";
import { isTauri } from "./is-tauri";

// Host routing, startup, authentication and layout parameters are never owned
// by plugins, even if a plugin accidentally declares one of these names.
const HOST_PARAMETERS = new Set([
  "lat",
  "lon",
  "zoom",
  "url",
  "project",
  "plugin",
  "plugins",
  "tool",
  "add",
  "serviceUrl",
  "serviceStyle",
  "serviceLayer",
  "style",
  "dataType",
  "data",
  "stac",
  "role",
  "shareRole",
  "embed",
  "viewer",
  "theme",
  "lang",
  "language",
  "collab",
  "code",
  "state",
  "error",
  "error_description",
  "session_state",
  "conn",
  "schema",
  "table",
  "geom",
  "srid",
  "layout",
  "panels",
  "toolbar",
  "draw",
  "locale",
  "uiProfile",
  "projectUrl",
  "project_url",
  "settingsUrl",
  "settingUrl",
  "screenshot",
  "iframe",
  "hidePanels",
  "maponly",
  "welcome",
  "loading",
]);

/** Merge against the address at write time so camera and plugin writes compose. */
export function replaceUrlParameters(params: URLSearchParams, names: readonly string[]): void {
  if (typeof window === "undefined" || isTauri() || names.length === 0) return;
  const url = new URL(window.location.href);
  for (const name of names) {
    url.searchParams.delete(name);
    for (const value of params.getAll(name)) url.searchParams.append(name, value);
  }
  if (url.href !== window.location.href) {
    window.history.replaceState(window.history.state, "", url.href);
  }
}

/** The manager supplies the ownership list; unscoped calls cannot write. */
export function setPluginUrlParameters(
  params: URLSearchParams,
  names: readonly string[] = [],
): void {
  replaceUrlParameters(
    params,
    names.filter((name) => !HOST_PARAMETERS.has(name)),
  );
}

export function setMapViewUrl(view: MapViewState): void {
  const [lon, lat] = view.center;
  if (![lon, lat, view.zoom].every(Number.isFinite)) return;
  const rounded = (value: number, digits: number) => String(Number(value.toFixed(digits)));
  replaceUrlParameters(
    new URLSearchParams({
      lat: rounded(lat, 6),
      lon: rounded(((((lon + 180) % 360) + 360) % 360) - 180, 6),
      zoom: rounded(view.zoom, 2),
    }),
    ["lat", "lon", "zoom"],
  );
}
