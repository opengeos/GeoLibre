import type { VectorControl, VectorLayerOptions } from "maplibre-gl-vector";

type ContainerControl = Pick<VectorControl, "addData" | "getLayers">;

/** Group the tables produced by one container import, including overlapping imports. */
export function groupVectorContainerImports(
  control: ContainerControl,
  addGroup: (name: string, ids: string[]) => void,
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
      let name = options.name;
      if (!name && typeof File !== "undefined" && source instanceof File) name = source.name;
      if (!name && typeof source === "string") {
        try {
          name = decodeURIComponent(new URL(source).pathname.split("/").pop() ?? "");
        } catch {
          name = source;
        }
      }
      addGroup(options.name || (name || result.name).replace(/\.[^.]+$/, ""), ids);
    }
    return result;
  };
}
