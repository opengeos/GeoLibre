import { Box3, LoadingManager, Mesh, Object3D, Vector3 } from "three";
import { ColladaLoader } from "three/addons/loaders/ColladaLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

const LARGE_MODEL_HORIZONTAL_SPAN_METERS = 1000;

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
  /** Minimum model-space up-axis coordinate after COLLADA unit/up-axis handling. */
  verticalMinMeters: number;
  /** Maximum model-space up-axis coordinate after COLLADA unit/up-axis handling. */
  verticalMaxMeters: number;
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

function horizontalSpan(box: Box3): number {
  if (box.isEmpty()) return 0;
  return Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
}

function recenterAuthoredHorizontalGeometry(scene: Object3D): void {
  const authoredBox = new Box3();
  const visited = new Set<string>();
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const geometry = object.geometry;
    const position = geometry.getAttribute("position");
    if (!position) return;
    const key = geometry.uuid;
    if (visited.has(key)) return;
    visited.add(key);
    const geometryBox = geometry.boundingBox ?? new Box3().setFromBufferAttribute(position);
    authoredBox.union(geometryBox);
  });
  if (authoredBox.isEmpty()) return;

  const centerX = (authoredBox.min.x + authoredBox.max.x) / 2;
  const centerY = (authoredBox.min.y + authoredBox.max.y) / 2;
  visited.clear();
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const geometry = object.geometry;
    const key = geometry.uuid;
    if (visited.has(key)) return;
    visited.add(key);
    geometry.translate(-centerX, -centerY, 0);
  });
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
  const sourceBox = new Box3().setFromObject(collada.scene);
  if (horizontalSpan(sourceBox) >= LARGE_MODEL_HORIZONTAL_SPAN_METERS) {
    // SketchUp/KMZ geological sections and terrain slabs often carry large
    // local east/north offsets, leaving the visual mesh kilometers away from
    // the KML <Location>. Recenter the authored vertices for large horizontal
    // models; building-scale assets keep their authored origin.
    recenterAuthoredHorizontalGeometry(collada.scene);
  }
  const box = new Box3().setFromObject(collada.scene);
  const radiusMeters = radiusFromOrigin(box);
  // ColladaLoader normalizes Z_UP assets to glTF's Y-up frame before export.
  // That Y axis becomes deck.gl's vertical axis after ScenegraphLayer's
  // standard glTF roll, so carry it for KML vertical anchoring.
  const verticalMinMeters = box.isEmpty() ? 0 : box.min.y;
  const verticalMaxMeters = box.isEmpty() ? 0 : box.max.y;

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
  return {
    glb: new Uint8Array(glb),
    radiusMeters,
    verticalMinMeters,
    verticalMaxMeters,
  };
}
