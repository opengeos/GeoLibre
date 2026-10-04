import type { GeoLibreLayer } from "@geolibre/core";

// Edit routes offered from an Identify result (#2932). Engine-neutral DOM: the
// app decides which layers are editable and what each action does, so the map
// package only draws the buttons and reports the click.

/** The feature an Identify result offers to edit. */
export interface IdentifyEditTarget {
  layer: GeoLibreLayer;
  /** The feature's id in the attribute table's scheme (`feature.id ?? index`). */
  featureId: string;
}

/** App-supplied edit actions for features shown in an Identify result. */
export interface MapCanvasIdentifyEditActions {
  /** Whether the layer's geometry can be edited in place right now. */
  canEditGeometry: (layer: GeoLibreLayer) => boolean;
  /** Whether the layer's attribute values can be edited right now. */
  canEditAttributes: (layer: GeoLibreLayer) => boolean;
  /** Start editing the target feature's geometry. */
  editGeometry: (target: IdentifyEditTarget) => void;
  /** Open the target feature's attributes for editing. */
  editAttributes: (target: IdentifyEditTarget) => void;
}

/** Button text for the Identify edit actions. */
export interface IdentifyEditActionLabels {
  editGeometry: string;
  editAttributes: string;
}

/**
 * Build the Edit geometry / Edit attributes buttons for one Identify result.
 *
 * @param layer The layer that owns the identified feature.
 * @param featureId The identified feature's id, or null when it is unknown.
 * @param actions The app's edit actions, or undefined when the host offers none.
 * @param labels Translated button text.
 * @param beforeAction Runs before an action, e.g. to close the popup.
 * @returns The button row, or null when no action applies to this feature.
 */
export function createIdentifyEditActionsElement(
  layer: GeoLibreLayer,
  featureId: string | null,
  actions: MapCanvasIdentifyEditActions | undefined,
  labels: IdentifyEditActionLabels,
  beforeAction?: () => void,
): HTMLElement | null {
  // Without an id there is no way to find the feature again in the layer.
  if (!actions || featureId === null) return null;
  const target: IdentifyEditTarget = { layer, featureId };
  const buttons: HTMLButtonElement[] = [];
  const addButton = (text: string, action: string, run: (target: IdentifyEditTarget) => void) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.identifyEditAction = action;
    button.className =
      "rounded border px-1.5 py-0.5 font-normal text-muted-foreground hover:bg-muted hover:text-foreground";
    button.textContent = text;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      beforeAction?.();
      run(target);
    });
    buttons.push(button);
  };
  if (actions.canEditGeometry(layer)) {
    addButton(labels.editGeometry, "geometry", actions.editGeometry);
  }
  if (actions.canEditAttributes(layer)) {
    addButton(labels.editAttributes, "attributes", actions.editAttributes);
  }
  if (buttons.length === 0) return null;
  const row = document.createElement("div");
  row.className = "geolibre-identify-edit-actions mt-2 flex flex-wrap items-center gap-1 text-xs";
  row.append(...buttons);
  return row;
}
