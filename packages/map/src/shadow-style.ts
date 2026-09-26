import type {
  FilterSpecification,
  LayerSpecification,
  SourceSpecification,
  StyleSpecification,
} from "maplibre-gl";

/**
 * A source as a control reads it back through `map.getSource(id)`: the spec's
 * fields, plus the mutators MapLibre's source classes carry. Mutators update
 * the recorded spec and nothing more.
 */
export type ShadowSource = Record<string, unknown> & {
  id: string;
  type: string;
  serialize: () => SourceSpecification;
  setData: (data: unknown) => ShadowSource;
  setTiles: (tiles: string[]) => ShadowSource;
  setUrl: (url: string) => ShadowSource;
  setCoordinates: (coordinates: unknown) => ShadowSource;
};

/** The Style Spec half of MapLibre's `Map`, as a shadow style implements it. */
export interface ShadowStyleMethods {
  addSource: (id: string, spec: SourceSpecification) => unknown;
  getSource: (id: string) => ShadowSource | undefined;
  removeSource: (id: string) => unknown;
  isSourceLoaded: (id: string) => boolean;
  areTilesLoaded: () => boolean;
  addLayer: (layer: LayerSpecification, beforeId?: string) => unknown;
  getLayer: (id: string) => LayerSpecification | undefined;
  removeLayer: (id: string) => unknown;
  moveLayer: (id: string, beforeId?: string) => unknown;
  setLayerZoomRange: (layerId: string, minzoom: number, maxzoom: number) => unknown;
  getLayersOrder: () => string[];
  setPaintProperty: (layerId: string, name: string, value: unknown) => unknown;
  getPaintProperty: (layerId: string, name: string) => unknown;
  setLayoutProperty: (layerId: string, name: string, value: unknown) => unknown;
  getLayoutProperty: (layerId: string, name: string) => unknown;
  setFilter: (layerId: string, filter?: FilterSpecification | null) => unknown;
  getFilter: (layerId: string) => FilterSpecification | undefined;
  getStyle: () => StyleSpecification;
  isStyleLoaded: () => boolean;
}

/**
 * Where the shadow style reports what it did: `fire` receives MapLibre's event
 * names (`error`, `styledata`, `sourcedata`, `data`) so a control listening on
 * the map hears the same events it would on MapLibre, and `self` is what the
 * chainable methods return (the map facade the methods are installed on).
 */
export interface ShadowStyleHost {
  fire: (type: string, data?: Record<string, unknown>) => void;
  self: () => unknown;
}

/**
 * Record a map's style without drawing it.
 *
 * A renderer with no MapLibre style (the ArcGIS Maps SDK) hands plugin
 * controls a map facade. A control that adds its sources and layers to the map
 * and mirrors them into the GeoLibre store - the Web Services catalogs do this
 * - only needs those calls to succeed and read back consistently: the store
 * record is what the renderer draws. This keeps the style the control built,
 * with MapLibre's contract for each call (a duplicate id or unknown layer
 * reports an `error` event rather than throwing, as MapLibre does), so the
 * control's own bookkeeping (`getLayer` before `addLayer`, `getStyle().sources`
 * to read tile URLs back) works. Nothing here is rendered.
 */
export function createShadowStyle(host: ShadowStyleHost): ShadowStyleMethods & {
  /**
   * The recorded style itself, uncopied, for a host-side reader that draws
   * it; unlike `getStyle`, which a control may mutate, the caller must not
   * edit it. Not a MapLibre method: keep it off the map facade.
   */
  peek: () => { sources: Record<string, Record<string, unknown>>; layers: LayerSpecification[] };
} {
  const sources = new Map<string, Record<string, unknown>>();
  const layers: LayerSpecification[] = [];
  let changeQueued = false;

  // MapLibre fires `styledata` after a style edit, asynchronously; so does
  // this, once per burst of edits, so a listener never re-enters mid-call.
  const changed = (sourceId?: string) => {
    if (sourceId !== undefined)
      queueMicrotask(() =>
        host.fire("sourcedata", { dataType: "source", sourceId, isSourceLoaded: true }),
      );
    if (changeQueued) return;
    changeQueued = true;
    queueMicrotask(() => {
      changeQueued = false;
      host.fire("styledata", { dataType: "style" });
      host.fire("data", { dataType: "style" });
    });
  };
  const fail = (message: string) => {
    host.fire("error", { error: new Error(message) });
    return host.self();
  };
  const layerIndex = (id: string) => layers.findIndex((layer) => layer.id === id);
  /** Where a layer goes: before `beforeId`, at the top without one, or null when it is unknown. */
  const insertAt = (beforeId?: string): number | null => {
    if (beforeId === undefined) return layers.length;
    const index = layerIndex(beforeId);
    return index < 0 ? null : index;
  };

  const sourceView = (id: string, spec: Record<string, unknown>): ShadowSource => {
    const update = (patch: Record<string, unknown>) => {
      // Merge into the recorded spec, not the one this view was built from; a
      // view of a removed source is detached, as a removed MapLibre source is.
      const current = sources.get(id);
      if (!current) return sourceView(id, spec);
      sources.set(id, { ...current, ...patch });
      changed(id);
      return sourceView(id, sources.get(id)!);
    };
    return {
      ...spec,
      id,
      type: String(spec.type),
      // The live entry, as a held MapLibre source reflects later edits.
      serialize: () => structuredClone(sources.get(id) ?? spec) as unknown as SourceSpecification,
      setData: (data) => update({ data }),
      setTiles: (tiles) => update({ tiles: [...tiles] }),
      setUrl: (url) => update({ url }),
      setCoordinates: (coordinates) => update({ coordinates }),
    };
  };

  const updateLayer = (
    layerId: string,
    edit: (layer: LayerSpecification) => LayerSpecification,
  ): unknown => {
    const index = layerIndex(layerId);
    if (index < 0) return fail(`Cannot style non-existing layer "${layerId}".`);
    layers[index] = edit(layers[index]);
    changed();
    return host.self();
  };
  const readProperty = (layerId: string, group: "paint" | "layout", name: string) => {
    const layer = layers[layerIndex(layerId)] as
      | (LayerSpecification & Record<"paint" | "layout", Record<string, unknown> | undefined>)
      | undefined;
    return layer?.[group]?.[name];
  };
  const writeProperty =
    (group: "paint" | "layout") => (layerId: string, name: string, value: unknown) =>
      updateLayer(layerId, (layer) => {
        const current = (layer as unknown as Record<string, Record<string, unknown> | undefined>)[
          group
        ];
        const next = { ...current };
        if (value === undefined || value === null) delete next[name];
        else next[name] = value;
        return { ...layer, [group]: next } as LayerSpecification;
      });

  return {
    addSource: (id, spec) => {
      if (sources.has(id)) return fail(`Source "${id}" already exists.`);
      sources.set(id, { ...(spec as unknown as Record<string, unknown>) });
      changed(id);
      return host.self();
    },
    getSource: (id) => {
      const spec = sources.get(id);
      return spec ? sourceView(id, spec) : undefined;
    },
    removeSource: (id) => {
      if (!sources.has(id)) return fail(`There is no source with ID "${id}".`);
      const user = layers.find((layer) => "source" in layer && layer.source === id);
      if (user)
        return fail(`Source "${id}" cannot be removed while layer "${user.id}" is using it.`);
      sources.delete(id);
      changed();
      return host.self();
    },
    isSourceLoaded: (id) => sources.has(id),
    areTilesLoaded: () => true,
    addLayer: (layer, beforeId) => {
      if (layerIndex(layer.id) >= 0) return fail(`Layer "${layer.id}" already exists.`);
      const source = "source" in layer ? layer.source : undefined;
      let recorded = layer;
      if (source && typeof source === "object") {
        // MapLibre accepts an inline source spec and registers it under the
        // layer's id.
        if (sources.has(layer.id)) return fail(`Source "${layer.id}" already exists.`);
        sources.set(layer.id, { ...(source as Record<string, unknown>) });
        recorded = { ...layer, source: layer.id } as LayerSpecification;
      } else if (typeof source === "string" && !sources.has(source)) {
        return fail(`Source "${source}" not found.`);
      }
      const at = insertAt(beforeId);
      if (at === null) {
        if (recorded !== layer) sources.delete(layer.id);
        return fail(`Cannot add layer "${layer.id}" before non-existing layer "${beforeId}".`);
      }
      layers.splice(at, 0, structuredClone(recorded));
      changed();
      return host.self();
    },
    getLayer: (id) => {
      const layer = layers[layerIndex(id)];
      return layer ? structuredClone(layer) : undefined;
    },
    removeLayer: (id) => {
      const index = layerIndex(id);
      if (index < 0) return fail(`Cannot remove non-existing layer "${id}".`);
      layers.splice(index, 1);
      changed();
      return host.self();
    },
    moveLayer: (id, beforeId) => {
      const index = layerIndex(id);
      if (index < 0) return fail(`The layer "${id}" does not exist in the map's style.`);
      if (id === beforeId) return host.self();
      if (beforeId !== undefined && layerIndex(beforeId) < 0)
        return fail(`Layer "${beforeId}" does not exist in the map's style.`);
      const [layer] = layers.splice(index, 1);
      layers.splice(insertAt(beforeId)!, 0, layer);
      changed();
      return host.self();
    },
    getLayersOrder: () => layers.map((layer) => layer.id),
    setLayerZoomRange: (layerId, minzoom, maxzoom) =>
      updateLayer(layerId, (layer) => ({ ...layer, minzoom, maxzoom })),
    setPaintProperty: writeProperty("paint"),
    getPaintProperty: (layerId, name) => readProperty(layerId, "paint", name),
    setLayoutProperty: writeProperty("layout"),
    getLayoutProperty: (layerId, name) => readProperty(layerId, "layout", name),
    setFilter: (layerId, filter) =>
      updateLayer(layerId, (layer) => {
        const next = { ...layer } as LayerSpecification & { filter?: FilterSpecification };
        if (filter === undefined || filter === null) delete next.filter;
        else next.filter = filter;
        return next;
      }),
    getFilter: (layerId) =>
      (layers[layerIndex(layerId)] as { filter?: FilterSpecification } | undefined)?.filter,
    getStyle: () =>
      structuredClone({
        version: 8,
        sources: Object.fromEntries(sources) as unknown as StyleSpecification["sources"],
        layers,
      }),
    isStyleLoaded: () => true,
    peek: () => ({ sources: Object.fromEntries(sources), layers }),
  };
}
