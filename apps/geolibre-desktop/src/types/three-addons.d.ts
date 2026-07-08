// three.js ships its addon examples (`three/addons/*`) as JavaScript without
// bundled type declarations under that import path, so declare the minimal
// surface used by the COLLADA -> GLB conversion.
declare module "three/addons/loaders/ColladaLoader.js" {
  import type { Group, LoadingManager } from "three";
  export class ColladaLoader {
    constructor(manager?: LoadingManager);
    parse(text: string, path: string): { scene: Group };
  }
}

declare module "three/addons/exporters/GLTFExporter.js" {
  import type { Object3D } from "three";
  export interface GLTFExporterOptions {
    binary?: boolean;
  }
  export class GLTFExporter {
    parse(
      input: Object3D,
      onDone: (result: ArrayBuffer | object) => void,
      onError: (error: unknown) => void,
      options?: GLTFExporterOptions,
    ): void;
  }
}
