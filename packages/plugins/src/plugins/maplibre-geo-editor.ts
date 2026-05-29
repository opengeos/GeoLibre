import { GeoEditor, type GeoEditorOptions } from "maplibre-gl-geo-editor";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

let geoEditorPosition: GeoLibreMapControlPosition = "top-left";

const GEO_EDITOR_OPTIONS = {
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
} satisfies Omit<GeoEditorOptions, "position">;

let geoEditorControl: GeoEditor | null = null;

export const maplibreGeoEditorPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-geo-editor",
  name: "GeoEditor",
  version: "0.7.3",
  activate: (app: GeoLibreAppAPI) => {
    if (!geoEditorControl) {
      geoEditorControl = new GeoEditor(getGeoEditorOptions());
    }

    const added = app.addMapControl(geoEditorControl, geoEditorPosition);
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
  getMapControlPosition: () => geoEditorPosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    geoEditorPosition = position;
    if (!geoEditorControl) return;
    app.removeMapControl(geoEditorControl);
    const added = app.addMapControl(geoEditorControl, geoEditorPosition);
    if (!added) return false;
    setTimeout(() => geoEditorControl?.expand(), 0);
  },
};

function getGeoEditorOptions(): GeoEditorOptions {
  return {
    ...GEO_EDITOR_OPTIONS,
    position: geoEditorPosition,
  };
}
