declare module "@esri/maplibre-arcgis" {
  import type maplibregl from "maplibre-gl";

  export interface IHostedLayerOptions {
    attribution?: string;
    portalUrl?: string;
    token?: string;
  }

  export interface IFeatureLayerOptions extends IHostedLayerOptions {
    itemId?: string;
    url?: string;
  }

  export interface IVectorTileLayerOptions extends IHostedLayerOptions {
    itemId?: string;
    url?: string;
  }

  export abstract class HostedLayer {
    readonly sourceId?: string;
    readonly sources: Readonly<Record<string, maplibregl.AnySourceData>>;
    readonly layers: Readonly<maplibregl.LayerSpecification[]>;
    addSourcesAndLayersTo(map: maplibregl.Map): HostedLayer;
    setSourceId(oldId: string, newId: string): void;
  }

  export class FeatureLayer extends HostedLayer {
    static fromPortalItem(
      itemId: string,
      options?: IFeatureLayerOptions,
    ): Promise<FeatureLayer>;
    static fromUrl(
      serviceUrl: string,
      options?: IFeatureLayerOptions,
    ): Promise<FeatureLayer>;
  }

  export class VectorTileLayer extends HostedLayer {
    static fromPortalItem(
      itemId: string,
      options?: IVectorTileLayerOptions,
    ): Promise<VectorTileLayer>;
    static fromUrl(
      serviceUrl: string,
      options?: IVectorTileLayerOptions,
    ): Promise<VectorTileLayer>;
  }
}
