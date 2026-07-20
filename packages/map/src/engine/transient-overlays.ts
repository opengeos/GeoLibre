import type maplibregl from "maplibre-gl";
import type { GeoJsonOverlaySpec } from "./types";

/** Owns restorable MapLibre sources/layers for engine transient overlays. */
export class MapLibreTransientOverlays {
  private readonly specs = new Map<string, GeoJsonOverlaySpec>();

  constructor(private readonly map: maplibregl.Map) {}

  ids(): readonly string[] {
    return [...this.specs.keys()];
  }

  upsert(spec: GeoJsonOverlaySpec): void {
    this.specs.set(spec.id, spec);
    this.apply(spec);
  }

  setVisible(id: string, visible: boolean): void {
    const existing = this.specs.get(id);
    if (existing) this.specs.set(id, { ...existing, visible });
    const visibility = visible ? "visible" : "none";
    for (const layerId of this.layerIds(id)) {
      if (this.map.getLayer(layerId)) {
        this.map.setLayoutProperty(layerId, "visibility", visibility);
      }
    }
  }

  remove(id: string): void {
    this.specs.delete(id);
    for (const layerId of this.layerIds(id)) {
      if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    }
    const sourceId = this.sourceId(id);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
  }

  /** Recreate every retained overlay after a renderer style replacement. */
  restore(): void {
    for (const spec of this.specs.values()) this.apply(spec);
  }

  destroy(): void {
    for (const id of [...this.specs.keys()]) this.remove(id);
  }

  private sourceId(id: string): string {
    return `geolibre-engine-overlay-${id}`;
  }

  private layerIds(id: string): readonly string[] {
    const sourceId = this.sourceId(id);
    return [`${sourceId}-fill`, `${sourceId}-line`, `${sourceId}-point`];
  }

  private apply(spec: GeoJsonOverlaySpec): void {
    if (typeof this.map.isStyleLoaded === "function" && !this.map.isStyleLoaded()) return;
    const sourceId = this.sourceId(spec.id);
    const source = this.map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
    if (source) source.setData(spec.data);
    else this.map.addSource(sourceId, { type: "geojson", data: spec.data });

    const visibility = spec.visible === false ? "none" : "visible";
    const lineColor = spec.style?.lineColorProperty
      ? (["get", spec.style.lineColorProperty] as maplibregl.ExpressionSpecification)
      : (spec.style?.lineColor ?? "#2563eb");
    const definitions: maplibregl.LayerSpecification[] = [
      {
        id: `${sourceId}-fill`,
        type: "fill",
        source: sourceId,
        filter: ["==", ["geometry-type"], "Polygon"],
        layout: { visibility },
        paint: {
          "fill-color": spec.style?.fillColor ?? "#2563eb",
          "fill-opacity": spec.style?.fillOpacity ?? 0.2,
        },
      },
      {
        id: `${sourceId}-line`,
        type: "line",
        source: sourceId,
        layout: { visibility },
        paint: {
          "line-color": lineColor,
          "line-opacity": spec.style?.lineOpacity ?? 1,
          "line-width": spec.style?.lineWidth ?? 2,
          ...(spec.style?.lineDash ? { "line-dasharray": [...spec.style.lineDash] } : {}),
        },
      },
      {
        id: `${sourceId}-point`,
        type: "circle",
        source: sourceId,
        filter: ["==", ["geometry-type"], "Point"],
        layout: { visibility },
        paint: {
          "circle-color": spec.style?.pointColor ?? "#2563eb",
          "circle-opacity": spec.style?.pointOpacity ?? 1,
          "circle-radius": spec.style?.pointRadius ?? 5,
        },
      },
    ];
    for (const definition of definitions) {
      if (!this.map.getLayer(definition.id)) {
        this.map.addLayer(definition);
        continue;
      }
      this.map.setLayoutProperty(definition.id, "visibility", visibility);
      for (const [property, value] of Object.entries(definition.paint ?? {})) {
        this.map.setPaintProperty(definition.id, property, value);
      }
      if (definition.type === "line" && !spec.style?.lineDash) {
        this.map.setPaintProperty(definition.id, "line-dasharray", null);
      }
    }
  }
}
