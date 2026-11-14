import {
  initialLayerStyle,
  useAppStore,
  withoutHistory,
  type DominantGeometry,
} from "@geolibre/core";
import type { VectorControl, VectorLayerOptions, VectorLayerStyle } from "maplibre-gl-vector";

type ContainerControl = Pick<VectorControl, "addData" | "getLayers">;

/**
 * Group the tables produced by one container import, including overlapping
 * imports, and report every layer each `addData` call created.
 *
 * @param control - The vector control whose `addData` is wrapped.
 * @param addGroup - Called with the new layer ids when one import produced
 *   more than one table (a multi-table container).
 * @param onImported - Called with the ids of every layer an import added to
 *   the project, single layer or container, before `addGroup`, along with the
 *   caller's style. Layers the store already held (a replay) are left out.
 */
export function groupVectorContainerImports(
  control: ContainerControl,
  addGroup: (name: string, ids: string[], style?: Partial<VectorLayerStyle>) => void,
  onImported?: (ids: string[], style?: Partial<VectorLayerStyle>) => void,
): void {
  const addData = control.addData.bind(control);
  control.addData = async (source, options: VectorLayerOptions = {}) => {
    const id = options.id ?? crypto.randomUUID();
    const previous = new Set(control.getLayers().map((layer) => layer.id));
    // A replay (project restore, refresh) re-adds layers the store already
    // holds; those are not new to the project and keep their saved style.
    const known = new Set(useAppStore.getState().layers.map((layer) => layer.id));
    const result = await addData(source, { ...options, id });
    // The vector control derives each selected table's id from the container id.
    // A prefix scoped to this call avoids grouping layers from concurrent loads.
    const created = control
      .getLayers()
      .filter(
        (layer) => !previous.has(layer.id) && (layer.id === id || layer.id.startsWith(`${id}-`)),
      )
      .map((layer) => layer.id);
    onImported?.(
      created.filter((layerId) => !known.has(layerId)),
      options.style,
    );
    const ids = created.filter((layerId) => layerId !== id);
    if (ids.length > 1) {
      // An explicit display name is user-authored, not a filename. Preserve it,
      // including dots; strip the extension only from a derived source name.
      if (options.name) {
        addGroup(options.name, ids, options.style);
        return result;
      }
      let name: string | undefined;
      if (!name && typeof File !== "undefined" && source instanceof File) name = source.name;
      if (!name && typeof source === "string") {
        try {
          name = decodeURIComponent(new URL(source).pathname.split("/").pop() ?? "");
        } catch {
          name = source;
        }
      }
      addGroup((name || result.name).replace(/\.[^.]+$/, ""), ids, options.style);
    }
    return result;
  };
}

/** Geometry families {@link initialLayerStyle} sizes for, by control category. */
const CONTROL_GEOMETRY: Record<string, DominantGeometry> = {
  point: "point",
  line: "line",
  polygon: "polygon",
};

/**
 * Give layers newly added through the vector control the as-added look a
 * drag-and-drop layer gets: the next unused palette color, an outline derived
 * from it, and sizing for the layer's geometry (see {@link initialLayerStyle}).
 * Without this every such layer kept the control's own `#3388ff` default, and
 * because that is not a palette color the Style panel never offered its style
 * suggestions for it either.
 *
 * A caller that supplied any color (a project restore replaying its saved
 * style, an API add with an explicit style) keeps its whole style; one that
 * supplied only sizing or opacity keeps those fields and gets the palette
 * color. The restyle is left out of the undo history, so one undo still
 * removes the added layer.
 *
 * @param ids - The store ids of the layers one `addData` call created.
 * @param style - The style the caller passed to `addData`, if any.
 */
export function applyInitialVectorStyles(ids: string[], style?: Partial<VectorLayerStyle>): void {
  if (
    style &&
    [
      style.fillColor,
      style.lineColor,
      style.circleColor,
      style.fillColorExpression,
      style.lineColorExpression,
      style.circleColorExpression,
    ].some((color) => color !== undefined)
  )
    return;
  // The store seeds these fields from the control, which applied the caller's
  // values; keep them rather than replacing them with geometry defaults.
  const keepWidth = style?.lineWidth !== undefined;
  const keepRadius = style?.circleRadius !== undefined;
  if (ids.length === 0) return;
  withoutHistory(() => {
    for (const id of ids) {
      const state = useAppStore.getState();
      const layer = state.layers.find((candidate) => candidate.id === id);
      if (!layer) continue;
      const geometryType = layer.metadata.geometryType;
      // The store's fillOpacity mirrors circleOpacity on a point layer and
      // fillOpacity otherwise (see vectorStyleToLayerStyle).
      const keepOpacity =
        (geometryType === "point" ? style?.circleOpacity : style?.fillOpacity) !== undefined;
      const initial = initialLayerStyle({
        layers: state.layers,
        geometry: (typeof geometryType === "string" && CONTROL_GEOMETRY[geometryType]) || "mixed",
      });
      state.updateLayer(id, {
        style: {
          ...layer.style,
          fillColor: initial.fillColor,
          strokeColor: initial.strokeColor,
          fillOpacity: keepOpacity ? layer.style.fillOpacity : initial.fillOpacity,
          strokeWidth: keepWidth ? layer.style.strokeWidth : initial.strokeWidth,
          circleRadius: keepRadius ? layer.style.circleRadius : initial.circleRadius,
        },
      });
    }
  });
}
