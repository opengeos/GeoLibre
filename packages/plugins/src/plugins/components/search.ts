// The standalone Search Places panel.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import type { SearchControl, SearchControlOptions } from "maplibre-gl-components";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import { getComponentsConstructors, type SearchControlConstructor } from "./constructors";

const searchControlPosition: GeoLibreMapControlPosition = "top-right";

const SEARCH_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-search-control",
  collapsed: false,
  fontColor: "hsl(var(--popover-foreground))",
  maxResults: 8,
  width: 320,
} satisfies SearchControlOptions;

const SEARCH_PLACEHOLDER_KEY = "toolbar.item.searchPlacesPlaceholder";
const SEARCH_PLACEHOLDER_DEFAULT = "Search places…";

let searchControl: SearchControl | null = null;
let searchControlMounted = false;
let searchPlacesPanelVisible = false;
let searchRequest = 0;
let unsubscribeSearchLocale: (() => void) | null = null;
const searchPlacesPanelListeners = new Set<() => void>();

// The standalone Search panel is intentionally independent from the
// ControlGrid search sub-control so it can be used from the Controls menu.
export function openSearchPlacesPanel(app: GeoLibreAppAPI): void {
  void openStandaloneSearchControl(app);
}

export function closeSearchPlacesPanel(): void {
  hideSearchControl();
}

export function isSearchPlacesPanelVisible(): boolean {
  return searchPlacesPanelVisible;
}

export function subscribeSearchPlacesPanel(listener: () => void): () => void {
  searchPlacesPanelListeners.add(listener);
  return () => searchPlacesPanelListeners.delete(listener);
}

async function openStandaloneSearchControl(
  app: GeoLibreAppAPI,
  request = ++searchRequest,
): Promise<boolean> {
  const { SearchControl: SearchControlClass } = await getComponentsConstructors();
  if (request !== searchRequest) return false;

  searchControl ??= createSearchControl(SearchControlClass, app);

  if (!searchControlMounted) {
    const added = app.addMapControl(searchControl, searchControlPosition);
    if (!added) {
      searchControl = null;
      unsubscribeSearchLocale?.();
      unsubscribeSearchLocale = null;
      return false;
    }
    searchControlMounted = true;
  }

  const control = searchControl;
  setTimeout(() => {
    if (request !== searchRequest || searchControl !== control) return;
    control.show();
    control.expand();
    setSearchPlacesPanelVisible(true);
  }, 0);
  return true;
}

// The panel's close (X) / collapse button emits "collapse". We deliberately do
// NOT tear the control down on collapse: collapsing just folds the panel back
// to its on-map icon (matching the Colorbar/Legend/HTML panels). Whether the
// icon stays on the map is governed solely by the Controls-menu checkbox —
// unchecking it calls the close*Panel helpers, which remove the control.
function createSearchControl(
  SearchControlClass: SearchControlConstructor,
  app: GeoLibreAppAPI,
): SearchControl {
  const control = new SearchControlClass({
    ...SEARCH_OPTIONS,
    placeholder: searchPlaceholder(app),
  });
  // The control renders its input once, so re-apply the placeholder when the
  // app language changes while it exists.
  unsubscribeSearchLocale?.();
  unsubscribeSearchLocale =
    app.onLocaleChange?.(() => control.update({ placeholder: searchPlaceholder(app) })) ?? null;
  return control;
}

function searchPlaceholder(app: GeoLibreAppAPI): string {
  return (
    app.translate?.(SEARCH_PLACEHOLDER_KEY, SEARCH_PLACEHOLDER_DEFAULT) ??
    SEARCH_PLACEHOLDER_DEFAULT
  );
}

export function teardownSearchControl(app: GeoLibreAppAPI): void {
  ++searchRequest;
  if (searchControl && searchControlMounted) {
    app.removeMapControl(searchControl);
  }
  searchControl = null;
  searchControlMounted = false;
  unsubscribeSearchLocale?.();
  unsubscribeSearchLocale = null;
  setSearchPlacesPanelVisible(false);
}

function hideSearchControl(): void {
  ++searchRequest;
  searchControl?.hide();
  setSearchPlacesPanelVisible(false);
}

function setSearchPlacesPanelVisible(visible: boolean): void {
  if (searchPlacesPanelVisible === visible) return;
  searchPlacesPanelVisible = visible;
  for (const listener of searchPlacesPanelListeners) {
    listener();
  }
}
