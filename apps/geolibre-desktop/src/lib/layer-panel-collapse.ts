// Whether the Layers panel is currently collapsed to its rail. The panel owns
// that state locally (or its shared-rail parent does), so it publishes it here
// for Export as HTML, which reopens the export with the same chrome (#2764).

let layersPanelCollapsed = false;

/** Record the Layers panel's current collapse state. */
export function setLayersPanelCollapsed(collapsed: boolean): void {
  layersPanelCollapsed = collapsed;
}

/** Whether the Layers panel was last reported collapsed. */
export function isLayersPanelCollapsed(): boolean {
  return layersPanelCollapsed;
}
