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

declare module "three/addons/controls/OrbitControls.js" {
  import type { Camera, Vector3 } from "three";
  export class OrbitControls {
    constructor(camera: Camera, domElement?: HTMLElement);
    target: Vector3;
    enableDamping: boolean;
    dampingFactor: number;
    enablePan: boolean;
    minDistance: number;
    maxDistance: number;
    rotateSpeed: number;
    zoomSpeed: number;
    update(): boolean;
    dispose(): void;
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
