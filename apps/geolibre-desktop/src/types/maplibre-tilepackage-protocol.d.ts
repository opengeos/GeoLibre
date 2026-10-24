// maplibre-tilepackage-protocol ships no type declarations. This covers only
// the slice GeoLibre uses to open an ArcGIS vector (VTPK) or raster (TPKX) tile
// package and serve it through MapLibre's `tilepackage://` protocol.
declare module "maplibre-tilepackage-protocol" {
  import type { AddProtocolAction, StyleSpecification } from "maplibre-gl";

  /** The parsed `root.json` of a package, flattened by the library. */
  export interface TilePackageHeader {
    type: "vtpk" | "tpkx";
    name?: string;
    description?: string;
    attribution?: string;
    version?: string;
    packageType: "vtpk" | "tpkx";
    /** The package's declared spatial reference (a WKID), when it has one. */
    spatialReference?: number;
    tileType?: string;
    tileSize?: number;
    minZoom?: number;
    maxZoom?: number;
    /**
     * The package extent (`extent.xmin/ymin/xmax/ymax` of `root.json`). The
     * names say degrees, but the values are in the package's own coordinate
     * system and are not reliably longitude/latitude.
     */
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  }

  export interface TilePackageOptions {
    /** Skip the (slower) coverage map; disables over-zooming sparse tiles. */
    coverageCheck?: boolean;
    maxDz?: number;
  }

  /** Where the archive's bytes come from. */
  export class Source {
    getKey(): string;
  }

  /** Reads a package from a browser `File` through `File.slice`, never whole. */
  export class FileSource extends Source {
    constructor(file: File);
    getKey(): string;
  }

  /** Reads a remote package with HTTP range requests. */
  export class FetchSource extends Source {
    constructor(url: string);
  }

  export class TilePackage {
    constructor(source: string | Source, options?: TilePackageOptions);
    readonly source: Source;
    getHeader(): Promise<TilePackageHeader>;
    getStyle(): Promise<StyleSpecification>;
  }

  export class Protocol {
    constructor(options?: { metadata?: boolean; errorOnMissingTile?: boolean; debug?: boolean });
    /** The MapLibre `addProtocol` handler (the callback and promise forms). */
    readonly package: AddProtocolAction;
    /** The registered packages by key; the only way to forget one (there is no `remove`). */
    readonly tiles: Map<string, TilePackage>;
    add(tilePackage: TilePackage): void;
    get(url: string): TilePackage | undefined;
  }
}
