import { GeoEditor, type GeoEditorOptions } from "maplibre-gl-geo-editor";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

const GEO_EDITOR_OPTIONS = {
  position: "top-left",
  collapsed: false,
  toolbarOrientation: "vertical",
  columns: 2,
  drawModes: ["polygon", "line", "rectangle", "circle", "marker", "freehand"],
  editModes: [
    "select",
    "drag",
    "change",
    "rotate",
    "cut",
    "delete",
    "scale",
    "copy",
    "split",
    "union",
    "difference",
    "simplify",
    "lasso",
  ],
  fileModes: ["open", "save"],
  hideGeomanControl: true,
  showFeatureProperties: true,
  fitBoundsOnLoad: true,
} satisfies GeoEditorOptions;

let geoEditorControl: GeoEditor | null = null;

export const maplibreGeoEditorPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-geo-editor",
  name: "GeoEditor",
  version: "0.7.3",
  activate: (app: GeoLibreAppAPI) => {
    if (!geoEditorControl) {
      geoEditorControl = new GeoEditor(GEO_EDITOR_OPTIONS);
    }

    const added = app.addMapControl(
      geoEditorControl,
      GEO_EDITOR_OPTIONS.position,
    );
    if (!added) {
      geoEditorControl = null;
      return false;
    }
    setTimeout(() => geoEditorControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!geoEditorControl) return;
    app.removeMapControl(geoEditorControl);
    geoEditorControl = null;
  },
};
