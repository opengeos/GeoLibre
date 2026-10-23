import { initialLayerStyle, useAppStore } from "@geolibre/core";
import type { VectorControl, VectorLayerOptions, VectorLayerStyle } from "maplibre-gl-vector";

type ContainerControl = Pick<VectorControl, "addData" | "getLayers">;

/** Group the tables produced by one container import, including overlapping imports. */
export function groupVectorContainerImports(
  control: ContainerControl,
  addGroup: (name: string, ids: string[], style?: Partial<VectorLayerStyle>) => void,
): void {
  const addData = control.addData.bind(control);
  control.addData = async (source, options: VectorLayerOptions = {}) => {
    const id = options.id ?? crypto.randomUUID();
    const previous = new Set(control.getLayers().map((layer) => layer.id));
    const result = await addData(source, { ...options, id });
    // The vector control derives each selected table's id from the container id.
    // A prefix scoped to this call avoids grouping layers from concurrent loads.
    const ids = control
      .getLayers()
      .filter((layer) => !previous.has(layer.id) && layer.id.startsWith(`${id}-`))
      .map((layer) => layer.id);
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

/** Give newly imported tables distinct default colors without replacing authored colors. */
export function applyVectorContainerColors(ids: string[], style?: Partial<VectorLayerStyle>): void {
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
  for (const id of ids) {
    const state = useAppStore.getState();
    const layer = state.layers.find((candidate) => candidate.id === id);
    if (!layer) continue;
    const { fillColor, strokeColor } = initialLayerStyle({ layers: state.layers });
    state.updateLayer(id, { style: { ...layer.style, fillColor, strokeColor } });
  }
}
