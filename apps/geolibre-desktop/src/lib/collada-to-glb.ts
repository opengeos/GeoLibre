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

  const loader = new ColladaLoader(manager);
  // ColladaLoader.parse is synchronous for geometry but kicks off async texture
  // loads through the manager; the scene is returned immediately.
  const collada = loader.parse(daeText, basePath);

  // Some COLLADA meshes ship without vertex normals, which makes lit PBR
  // shading fall back to flat geometric normals (luma.gl warns); compute them
  // so the exported model shades correctly.
  collada.scene.traverse((object) => {
    if (object instanceof Mesh && !object.geometry.getAttribute("normal")) {
      object.geometry.computeVertexNormals();
    }
  });

  await waitForManager(manager, textureTimeoutMs);

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

/**
 * Resolve once the loading manager reports all in-flight loads finished, or when
 * `timeoutMs` elapses (so a missing/hanging texture never blocks the model).
 * `ColladaLoader.parse` starts any texture loads synchronously, so if nothing
 * has started shortly after parse there are no textures and this resolves right
 * away instead of waiting out the timeout.
 */
function waitForManager(
  manager: LoadingManager,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let started = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    manager.onStart = () => {
      started = true;
    };
    manager.onLoad = finish;
    timer = setTimeout(finish, timeoutMs);
    // No texture load kicked off during parse -> untextured model, resolve now.
    setTimeout(() => {
      if (!started) finish();
    }, 50);
  });
}
