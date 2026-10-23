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
  placeholder: "Search places...",
  width: 320,
} satisfies SearchControlOptions;

let searchControl: SearchControl | null = null;
let searchControlMounted = false;
let searchPlacesPanelVisible = false;
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

async function openStandaloneSearchControl(app: GeoLibreAppAPI): Promise<boolean> {
  const { SearchControl: SearchControlClass } = await getComponentsConstructors();

  searchControl ??= createSearchControl(SearchControlClass);

  if (!searchControlMounted) {
    const added = app.addMapControl(searchControl, searchControlPosition);
    if (!added) {
      searchControl = null;
      return false;
    }
    searchControlMounted = true;
  }

  setTimeout(() => {
    searchControl?.show();
    searchControl?.expand();
    setSearchPlacesPanelVisible(true);
  }, 0);
  return true;
}

// The panel's close (X) / collapse button emits "collapse". We deliberately do
// NOT tear the control down on collapse: collapsing just folds the panel back
// to its on-map icon (matching the Colorbar/Legend/HTML panels). Whether the
// icon stays on the map is governed solely by the Controls-menu checkbox —
// unchecking it calls the close*Panel helpers, which remove the control.
function createSearchControl(SearchControlClass: SearchControlConstructor): SearchControl {
  const control = new SearchControlClass(SEARCH_OPTIONS);
  return control;
}

export function teardownSearchControl(app: GeoLibreAppAPI): void {
  if (searchControl && searchControlMounted) {
    app.removeMapControl(searchControl);
  }
  searchControl = null;
  searchControlMounted = false;
  setSearchPlacesPanelVisible(false);
}

function hideSearchControl(): void {
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
