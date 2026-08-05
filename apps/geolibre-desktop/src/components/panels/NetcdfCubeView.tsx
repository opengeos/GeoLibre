import { useEffect, useRef } from "react";
import {
  DataTexture,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  CUBE_FACES,
  paintCubeFace,
  sliceCube,
  type CubeFace,
  type CubeFaceImage,
  type NetcdfCube,
} from "../../lib/netcdf-cube";

/**
 * The image cube drawn as six textured planes.
 *
 * Six planes and not a volume: a uniform grid rendered with a surface mapper
 * (which is what PyVista's `add_mesh` does, and what HyperCoast's `image_cube`
 * shows) is its own exterior, so the top face is one band's map and the four
 * sides are the spectra along each edge. Ray-marching a 3-D texture would add
 * the interior, but nothing about the default view needs it, and this costs six
 * textures and no shader.
 *
 * Built as separate planes rather than one `BoxGeometry` with six materials so
 * each face's texel-to-cell mapping is stated in one place (`paintCubeFace`)
 * against world directions, instead of having to be inferred from the box's
 * built-in UV layout.
 */

/** Slack left around the cube's bounding sphere, so a rotation never clips it. */
const CAMERA_FIT = 1.15;

interface NetcdfCubeViewProps {
  /** The decoded cube. */
  cube: NetcdfCube;
  /** The ramp as `[r, g, b]` triples, low to high. */
  colors: Array<[number, number, number]>;
  /** The `[min, max]` the ramp is stretched across. */
  clim: [number, number];
  /**
   * Height of the band axis relative to the cube's shorter spatial edge. 1 makes
   * the cube as tall as it is wide; the default matches HyperCoast's auto-scale,
   * which spreads the spectrum over the full width of the scene.
   */
  zScale: number;
  /**
   * Band planes to keep, counted up from the first. Cutting down from the top
   * is the only way to see into a cube whose faces are opaque; the cube stays
   * where it was, so the cut reads as a plane descending through it rather than
   * as the whole model shrinking.
   */
  sliceBands: number;
  /** Whether to lay the cube's RGB composite over its top face. */
  showRgb?: boolean;
  /** Whether to draw with nearest-neighbour texels rather than smoothing. */
  sharp?: boolean;
}

/**
 * A WebGL canvas showing the cube, orbitable with the pointer.
 *
 * @param props - The cube, its symbology, and the vertical exaggeration.
 * @returns The canvas host element.
 */
export function NetcdfCubeView({
  cube,
  colors,
  clim,
  zScale,
  sliceBands,
  showRgb = true,
  sharp = true,
}: NetcdfCubeViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // The scene outlives a symbology change, so the textures are swapped in place
  // rather than by rebuilding it; these are what that swap reaches for.
  const facesRef = useRef<Map<CubeFace, Mesh> | null>(null);
  const groupRef = useRef<Group | null>(null);
  // The RGB overlay is a seventh plane rather than the top face's own texture,
  // so toggling it off restores the colormapped face underneath without a
  // repaint of anything else.
  const overlayRef = useRef<Mesh | null>(null);
  // Read by the scene effect to frame the cube on first build, without making
  // the whole scene depend on a value the geometry effect already handles.
  const zScaleRef = useRef(zScale);
  zScaleRef.current = zScale;

  // The scene itself: rebuilt only when the cube's geometry changes, because
  // that is what the plane sizes and the camera distance are derived from.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";

    const scene = new Scene();
    const camera = new PerspectiveCamera(45, 1, 0.1, 5000);
    // The band axis is "up" in this scene, and OrbitControls captures the
    // camera's up vector when it is constructed, so this has to be set first;
    // changing it afterwards leaves the controls orbiting about world +y and
    // the cube tumbling on its side as soon as the user drags.
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;

    const group = new Group();
    scene.add(group);
    groupRef.current = group;

    // World units are cells, so a cube reads at its true spatial aspect ratio;
    // only the band axis is scaled (see `zScale`).
    const width = cube.nx;
    const height = cube.ny;
    const faces = new Map<CubeFace, Mesh>();
    for (const face of CUBE_FACES) {
      const mesh = new Mesh(
        new PlaneGeometry(1, 1),
        new MeshBasicMaterial({
          // Both sides, so a face stays visible when the camera crosses under
          // the cube rather than the model appearing to have a hole in it.
          side: DoubleSide,
          transparent: true,
        }),
      );
      mesh.name = face;
      group.add(mesh);
      faces.set(face, mesh);
    }
    facesRef.current = faces;

    const overlay = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ side: DoubleSide, transparent: true }),
    );
    overlay.name = "rgb";
    overlay.visible = false;
    group.add(overlay);
    overlayRef.current = overlay;

    // Frame the cube from a raised three-quarter angle, the view that shows a
    // top face and two sides at once, at the distance where its bounding sphere
    // just fits. Fitting to the *narrower* of the two field-of-view angles is
    // what keeps the cube inside a wide, short panel: the camera's `fov` is the
    // vertical one, so on a wide canvas the vertical is the binding constraint,
    // and on a tall one the horizontal is.
    const fit = (): void => {
      const depth = Math.min(width, height) * zScaleRef.current;
      const radius = (Math.hypot(width, height, depth) / 2) * CAMERA_FIT;
      const vertical = (camera.fov * Math.PI) / 180;
      const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
      const distance = radius / Math.sin(Math.min(vertical, horizontal) / 2);
      // A unit vector towards the raised three-quarter view, scaled to that
      // distance, so the framing does not change as the cube's shape does.
      const direction = new Vector3(0.62, -0.66, 0.42).normalize();
      camera.position.copy(direction.multiplyScalar(distance));
      controls.target.set(0, 0, 0);
      controls.minDistance = radius * 0.4;
      controls.maxDistance = distance * 6;
      camera.lookAt(new Vector3(0, 0, 0));
      controls.update();
    };

    const resize = (): void => {
      const { clientWidth, clientHeight } = host;
      if (clientWidth === 0 || clientHeight === 0) return;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };
    resize();
    // After `resize`, so the first fit already knows the panel's aspect ratio;
    // fitting against the placeholder 1:1 would frame a wide panel wrongly.
    fit();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    let frame = 0;
    const tick = (): void => {
      frame = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      for (const mesh of [...faces.values(), overlay]) {
        mesh.geometry.dispose();
        const material = mesh.material as MeshBasicMaterial;
        material.map?.dispose();
        material.dispose();
      }
      facesRef.current = null;
      overlayRef.current = null;
      groupRef.current = null;
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [cube]);

  // Face geometry: placement and size depend on the cube's shape, the vertical
  // exaggeration, and where the slice plane sits — and on nothing about colors.
  useEffect(() => {
    const faces = facesRef.current;
    const overlay = overlayRef.current;
    if (!faces || !overlay) return;
    const width = cube.nx;
    const height = cube.ny;
    const full = Math.max(1, Math.min(width, height) * zScale);
    const kept = Math.min(cube.nz, Math.max(1, Math.trunc(sliceBands)));
    const depth = Math.max(full * (kept / cube.nz), full / cube.nz);
    // The bottom stays put and the top comes down, so a slice reads as a plane
    // descending through a cube standing still. Anchoring the centre instead
    // would make the whole model creep downwards as the user drags.
    const zCenter = -full / 2 + depth / 2;
    for (const [face, mesh] of faces) {
      placeFace(mesh, face, width, height, depth, zCenter);
    }
    // Just clear of the top face. The offset scales with the cube so it never
    // vanishes into z-fighting on a tall cube nor floats visibly on a flat one,
    // matching how HyperCoast lifts its own overlay off the top.
    overlay.geometry.dispose();
    overlay.geometry = new PlaneGeometry(width, height);
    overlay.position.set(0, 0, zCenter + depth / 2 + Math.max(full * 1e-3, 1e-4));
  }, [cube, zScale, sliceBands]);

  // Textures: repainted on a symbology change or a slice, both of which change
  // what each face shows without changing the cube.
  useEffect(() => {
    const faces = facesRef.current;
    if (!faces) return;
    const shown = sliceCube(cube, sliceBands);
    for (const [face, mesh] of faces) {
      applyTexture(mesh, paintCubeFace(shown, face, colors, clim), sharp);
    }
  }, [cube, colors, clim, sharp, sliceBands]);

  // The RGB overlay: its own texture, painted once per cube, so toggling it is
  // a visibility flip rather than a recompose.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.visible = showRgb && cube.rgb !== undefined;
    if (cube.rgb) applyTexture(overlay, cube.rgb, sharp);
  }, [cube, showRgb, sharp]);

  return <div ref={hostRef} className="h-full w-full" aria-hidden="true" />;
}

/**
 * Size, rotate, and position one face plane.
 *
 * The scene's axes are world east (+x), world north (+y), and the band axis
 * (+z). Each plane starts in the xy plane facing +z with its own u to the right
 * and v upward, so the rotations here are exactly what `faceSampleIndex` assumes
 * when it maps a texel to a cell.
 *
 * @param mesh - The face's mesh.
 * @param face - Which face it is.
 * @param width - Cube width in cells (x).
 * @param height - Cube height in cells (y).
 * @param depth - Visible depth in world units (the scaled, sliced band axis).
 * @param zCenter - Where the visible part's middle sits on the band axis.
 */
function placeFace(
  mesh: Mesh,
  face: CubeFace,
  width: number,
  height: number,
  depth: number,
  zCenter: number,
): void {
  mesh.geometry.dispose();
  mesh.rotation.set(0, 0, 0);
  const half = { x: width / 2, y: height / 2, z: depth / 2 };
  switch (face) {
    case "top":
      mesh.geometry = new PlaneGeometry(width, height);
      mesh.position.set(0, 0, zCenter + half.z);
      break;
    case "bottom":
      mesh.geometry = new PlaneGeometry(width, height);
      mesh.position.set(0, 0, zCenter - half.z);
      mesh.rotation.x = Math.PI;
      break;
    case "north":
      mesh.geometry = new PlaneGeometry(width, depth);
      mesh.position.set(0, half.y, zCenter);
      mesh.rotation.x = -Math.PI / 2;
      break;
    case "south":
      mesh.geometry = new PlaneGeometry(width, depth);
      mesh.position.set(0, -half.y, zCenter);
      mesh.rotation.x = Math.PI / 2;
      break;
    case "east":
      mesh.geometry = new PlaneGeometry(depth, height);
      mesh.position.set(half.x, 0, zCenter);
      mesh.rotation.y = Math.PI / 2;
      break;
    case "west":
      mesh.geometry = new PlaneGeometry(depth, height);
      mesh.position.set(-half.x, 0, zCenter);
      mesh.rotation.y = -Math.PI / 2;
      break;
  }
}

/**
 * Hand an RGBA image to a mesh as its texture, releasing the outgoing one.
 *
 * The dispose is not optional: these are megabytes of GPU memory each, and a
 * colormap change or a drag of the slice slider repaints all six faces.
 *
 * @param mesh - The mesh to texture.
 * @param image - The RGBA texels, row `v = 0` first.
 * @param sharp - Nearest-neighbour magnification rather than smoothing.
 */
function applyTexture(mesh: Mesh, image: CubeFaceImage, sharp: boolean): void {
  const texture = new DataTexture(
    image.pixels,
    image.width,
    image.height,
    RGBAFormat,
    UnsignedByteType,
  );
  // A cube face is one texel per cell, so smoothing blurs real data; the choice
  // is offered because a heavily decimated cube looks blocky.
  texture.magFilter = sharp ? NearestFilter : LinearFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const material = mesh.material as MeshBasicMaterial;
  material.map?.dispose();
  material.map = texture;
  material.needsUpdate = true;
}
