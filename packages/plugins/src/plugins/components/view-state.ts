// The standalone View State (Info) panel.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import type { ViewStateControl, ViewStateControlOptions } from "maplibre-gl-components";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import { getComponentsConstructors, type ViewStateControlConstructor } from "./constructors";

const viewStateControlPosition: GeoLibreMapControlPosition = "bottom-right";

const VIEW_STATE_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-view-state-control",
  collapsed: false,
  enableBBox: true,
  fontColor: "hsl(var(--popover-foreground))",
  maxHeight: 520,
  panelWidth: 280,
  position: viewStateControlPosition,
  // The panel title is applied per-instance in createViewStateControl so it
  // picks up the translated string pushed via setViewStateLabels.
} satisfies ViewStateControlOptions;

/**
 * User-facing strings for the ViewStateControl. The default is English; the
 * desktop shell pushes a translated value via {@link setViewStateLabels} since
 * this package is framework-agnostic and has no react-i18next access.
 */
const viewStateLabels = {
  title: "Info",
};

/** Override the ViewStateControl labels with translated text. */
export function setViewStateLabels(labels: Partial<typeof viewStateLabels>): void {
  for (const [key, value] of Object.entries(labels)) {
    // Only overwrite when the caller actually supplied the key; an omitted key
    // keeps the English default rather than being blanked out.
    if (value !== undefined) viewStateLabels[key as keyof typeof viewStateLabels] = value;
  }
}

let viewStateControl: ViewStateControl | null = null;
let viewStateControlMounted = false;
let viewStatePanelVisible = false;
const viewStatePanelListeners = new Set<() => void>();

// Standalone View State panel, toggled from the Controls menu.
export function openViewStatePanel(app: GeoLibreAppAPI): void {
  void openStandaloneViewStateControl(app);
}

export function closeViewStatePanel(app: GeoLibreAppAPI): void {
  teardownViewStateControl(app);
}

export function isViewStatePanelVisible(): boolean {
  return viewStatePanelVisible;
}

export function subscribeViewStatePanel(listener: () => void): () => void {
  viewStatePanelListeners.add(listener);
  return () => viewStatePanelListeners.delete(listener);
}

async function openStandaloneViewStateControl(app: GeoLibreAppAPI): Promise<boolean> {
  const { ViewStateControl: ViewStateControlClass } = await getComponentsConstructors();

  viewStateControl ??= createViewStateControl(ViewStateControlClass);

  if (!viewStateControlMounted) {
    const added = app.addMapControl(viewStateControl, viewStateControlPosition);
    if (!added) {
      viewStateControl = null;
      return false;
    }
    viewStateControlMounted = true;
  }

  setTimeout(() => {
    if (!viewStateControl) return;
    viewStateControl.show();
    viewStateControl.expand();
    setViewStatePanelVisible(true);
  }, 0);
  return true;
}

function createViewStateControl(
  ViewStateControlClass: ViewStateControlConstructor,
): ViewStateControl {
  const control = new ViewStateControlClass({
    ...VIEW_STATE_OPTIONS,
    title: viewStateLabels.title,
  });
  return control;
}

export function teardownViewStateControl(app: GeoLibreAppAPI): void {
  if (viewStateControl && viewStateControlMounted) {
    app.removeMapControl(viewStateControl);
  }
  viewStateControl = null;
  viewStateControlMounted = false;
  setViewStatePanelVisible(false);
}

function setViewStatePanelVisible(visible: boolean): void {
  if (viewStatePanelVisible === visible) return;
  viewStatePanelVisible = visible;
  for (const listener of viewStatePanelListeners) {
    listener();
  }
}
