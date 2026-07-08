import { Box3, LoadingManager, Mesh, Vector3 } from "three";
import { ColladaLoader } from "three/addons/loaders/ColladaLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

/** The result of converting a COLLADA `.dae` to a GLB. */
export interface ConvertedModel {
  /** The model encoded as binary glTF (GLB) bytes. */
  glb: Uint8Array;
  /**
   * The model's extent as the maximum distance (in meters, after the DAE's
   * `<unit>` scale) from its origin — the point a KML `<Location>` anchors to —
   * to any corner of its bounding box. A KML/SketchUp model's origin is often a
   * corner rather than the center and the mesh can span kilometers, so callers
   * use this to frame the whole model instead of zooming to a tiny box at the
   * anchor. `0` when the scene is empty.
   */
  radiusMeters: number;
}

// The largest distance from the origin (0,0,0) to any of the 8 corners of a
// bounding box. Rotation-invariant, so it bounds the model's horizontal footprint
// under any `<Orientation>`/deck.gl transform, which is what framing needs.
function radiusFromOrigin(box: Box3): number {
  if (box.isEmpty()) return 0;
  const corner = new Vector3();
  let max = 0;
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        max = Math.max(max, corner.set(x, y, z).length());
      }
    }
  }
  return max;
}

/**
 * Convert COLLADA (`.dae`) text into a binary glTF (GLB) so a KML `<Model>` can
 * be rendered by the existing glTF scenegraph layer instead of needing a
 * dedicated COLLADA renderer.
 *
 * Texture references inside the DAE are resolved through `resolveTexture` (for a
 * KMZ, this maps a packaged image's relative path to a blob URL of the archive
 * entry). Textures load asynchronously, so the conversion waits for the loading
 * manager to settle (bounded by `textureTimeoutMs`) before exporting; an
 * unresolved or slow texture yields an untextured model rather than aborting.
 *
 * @param daeText - The raw COLLADA XML text.
 * @param resolveTexture - Maps a texture URL/path referenced by the DAE to a
 *   loadable URL (e.g. an archive blob URL), or returns undefined to leave it
 *   unchanged.
 * @param basePath - Base URL/path COLLADA texture references resolve against
 *   (the `.dae`'s directory); leave empty when `resolveTexture` maps raw paths.
 * @param textureTimeoutMs - Maximum time to wait for textures to load.
 * @returns The model's GLB bytes and its extent (see {@link ConvertedModel}).
 */
export async function convertDaeToGlb(
  daeText: string,
  resolveTexture?: (url: string) => string | undefined,
  basePath = "",
  textureTimeoutMs = 8000,
): Promise<ConvertedModel> {
  const manager = new LoadingManager();
  if (resolveTexture) {
    manager.setURLModifier((url) => resolveTexture(url) ?? url);
  }

  // Wire the manager's start/done handlers BEFORE parsing: `ColladaLoader.parse`
  // starts texture loads synchronously, so `onStart` must already be attached to
  // observe them, and `onLoad` must be attached to catch completion.
  let started = false;
  let loaded = false;
  manager.onStart = () => {
    started = true;
  };
  const texturesLoaded = new Promise<void>((resolve) => {
    manager.onLoad = () => {
      loaded = true;
      resolve();
    };
  });

  const loader = new ColladaLoader(manager);
  // Geometry is returned synchronously; textures load asynchronously through the
  // manager wired above.
  const collada = loader.parse(daeText, basePath);

  // Some COLLADA meshes ship without vertex normals, which makes lit PBR
  // shading fall back to flat geometric normals (luma.gl warns); compute them
  // so the exported model shades correctly.
  collada.scene.traverse((object) => {
    if (object instanceof Mesh && !object.geometry.getAttribute("normal")) {
      object.geometry.computeVertexNormals();
    }
  });

  // Measure the model (world-space, so the DAE's <unit> scale and Z-up→Y-up
  // conversion are already baked in) before exporting, so the caller can frame
  // the whole thing.
  const radiusMeters = radiusFromOrigin(new Box3().setFromObject(collada.scene));

  // Wait for textures only when a load actually started during parse; otherwise
  // there are none and there is nothing to wait for. A missing/hanging texture
  // never blocks the model past `textureTimeoutMs` (yielding an untextured one).
  if (started && !loaded) {
    await Promise.race([
      texturesLoaded,
      new Promise<void>((resolve) => setTimeout(resolve, textureTimeoutMs)),
    ]);
  }

  const exporter = new GLTFExporter();
  const glb = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      collada.scene,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(result);
        else reject(new Error("GLTFExporter did not return binary GLB output."));
      },
      (error) => reject(error),
      { binary: true },
    );
  });
  return { glb: new Uint8Array(glb), radiusMeters };
}
