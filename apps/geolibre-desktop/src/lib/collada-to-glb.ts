import { LoadingManager, Mesh } from "three";
import { ColladaLoader } from "three/addons/loaders/ColladaLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

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
 * @returns The model encoded as GLB bytes.
 */
export async function convertDaeToGlb(
  daeText: string,
  resolveTexture?: (url: string) => string | undefined,
  basePath = "",
  textureTimeoutMs = 8000,
): Promise<Uint8Array> {
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
  return new Uint8Array(glb);
}
