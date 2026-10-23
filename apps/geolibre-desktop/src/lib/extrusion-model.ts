import {
  compileFeatureExpression,
  extrusionColorValue,
  extrusionHeightValue,
  isStyleSpecColor,
  styleValue,
  type LayerStyle,
} from "@geolibre/core";
import earcut from "earcut";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

/**
 * Export a 3D-extruded polygon layer as a mesh that desktop 3D tools (Blender,
 * MeshLab, SketchUp, slicers) open: binary glTF (`.glb`), Wavefront OBJ, or
 * binary STL (discussion #2825).
 *
 * Each polygon feature becomes one closed solid (floor, roof and walls) built
 * from the very height and colour the map paints (`extrusionHeightValue` /
 * `extrusionColorValue`), so categorized, graduated and expression-driven
 * styles export as drawn. Coordinates are metres in a local tangent plane
 * centred on the layer's bounding box (x east, y north, z up), which keeps
 * city-scale models accurate and small enough for single-precision floats.
 * glTF and OBJ are written Y-up as those formats expect; STL stays Z-up, the
 * convention of the CAD and printing tools that read it.
 */

/** A file format the extrusion model export can write. */
export type ExtrusionModelFormat = "glb" | "obj" | "stl";

/** One feature's closed, flat-shaded solid in local Z-up metres. */
export interface ExtrudedSolid {
  /** A display name: the feature's `name` property, its id, or its index. */
  name: string;
  /** Linear-light RGB (0..1), the feature's evaluated extrusion colour. */
  color: [number, number, number];
  /** The feature's attributes, carried into glTF `extras`. */
  properties: Record<string, unknown>;
  /** Vertex positions, xyz per vertex. */
  positions: number[];
  /** Per-vertex normals, xyz per vertex. */
  normals: number[];
  /** Triangle vertex indices, counter-clockwise seen from outside. */
  indices: number[];
}

/** The meshes built from a layer, ready to encode. */
export interface ExtrusionModel {
  solids: ExtrudedSolid[];
  /** The [lon, lat] of the local origin, so the model can be georeferenced. */
  origin: [number, number];
  /**
   * Polygon features left out: their top was not above their base, or no
   * ring had an area to extrude.
   */
  skipped: number;
}

const EARTH_RADIUS = 6378137;
const DEG = Math.PI / 180;

/** sRGB (0..1) to linear light, the space glTF material factors are in. */
function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/**
 * Compile a constant or MapLibre expression into a per-feature reader. A
 * value the style-spec cannot compile reads as `undefined`, so the caller's
 * fallback applies instead of aborting the export.
 */
function featureReader(
  value: unknown,
  expectedType: "number" | "color",
  zoom: number,
): (feature: Feature) => unknown {
  // A flat colour string still needs parsing, so route it through `to-color`.
  const source = Array.isArray(value)
    ? value
    : expectedType === "color" && typeof value === "string"
      ? ["to-color", value]
      : null;
  if (!source) return () => value;
  const compiled = compileFeatureExpression(JSON.stringify(source), { expectedType, zoom });
  const evaluate = compiled.evaluate;
  if (!evaluate) return () => undefined;
  return (feature) => {
    try {
      return evaluate(feature);
    } catch {
      return undefined;
    }
  };
}

/** The polygons of a geometry, each as its list of rings. */
function polygonsOf(geometry: Geometry | null): Position[][][] {
  if (!geometry) return [];
  switch (geometry.type) {
    case "Polygon":
      return [geometry.coordinates];
    case "MultiPolygon":
      return geometry.coordinates;
    case "GeometryCollection":
      return geometry.geometries.flatMap((member) => polygonsOf(member));
    default:
      return [];
  }
}

/**
 * Extend a [minLon, minLat, maxLon, maxLat, minLon360, maxLon360] box by every
 * polygon vertex. The last two track longitudes in 0..360, whose span is the
 * narrower one for data straddling the antimeridian.
 */
function extendBounds(bounds: number[], polygons: Position[][][]): void {
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [lon, lat] of ring) {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        bounds[0] = Math.min(bounds[0], lon);
        bounds[1] = Math.min(bounds[1], lat);
        bounds[2] = Math.max(bounds[2], lon);
        bounds[3] = Math.max(bounds[3], lat);
        const lon360 = lon < 0 ? lon + 360 : lon;
        bounds[4] = Math.min(bounds[4], lon360);
        bounds[5] = Math.max(bounds[5], lon360);
      }
    }
  }
}

/** Twice the signed area of a 2D ring; positive when counter-clockwise. */
function signedArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[i][1] + ring[j][1]);
  }
  return sum;
}

/**
 * Project a ring to local metres, dropping the closing vertex, repeated
 * vertices and non-finite positions. Returns null when fewer than three
 * distinct vertices remain or the ring has no area.
 */
function projectRing(
  ring: Position[],
  project: (lon: number, lat: number) => [number, number],
): number[][] | null {
  const points: number[][] = [];
  for (const position of ring) {
    const [lon, lat] = position;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const point = project(lon, lat);
    const last = points[points.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    points.push(point);
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length > 1 && first[0] === last[0] && first[1] === last[1]) points.pop();
  if (points.length < 3 || signedArea(points) === 0) return null;
  return points;
}

/** Append one extruded polygon (floor, roof and walls) to a solid. */
function appendPolygon(
  solid: ExtrudedSolid,
  polygon: Position[][],
  base: number,
  top: number,
  project: (lon: number, lat: number) => [number, number],
): void {
  const rings: number[][][] = [];
  for (const [index, ring] of polygon.entries()) {
    const projected = projectRing(ring, project);
    if (!projected) {
      // Without an outer ring the holes have nothing to cut.
      if (index === 0) return;
      continue;
    }
    // The outer ring runs counter-clockwise and the holes clockwise, so every
    // wall's outward normal is the edge direction turned clockwise.
    const ccw = signedArea(projected) > 0;
    if (ccw !== (index === 0)) projected.reverse();
    rings.push(projected);
  }
  if (rings.length === 0) return;

  const { positions, normals, indices } = solid;
  const flat: number[] = [];
  const holes: number[] = [];
  for (const [index, ring] of rings.entries()) {
    if (index > 0) holes.push(flat.length / 2);
    for (const [x, y] of ring) flat.push(x, y);
  }
  const triangles = earcut(flat, holes, 2);
  const vertexCount = flat.length / 2;

  // Roof (normal up) then floor (normal down), sharing earcut's triangles.
  const roofStart = positions.length / 3;
  for (let i = 0; i < vertexCount; i++) {
    positions.push(flat[i * 2], flat[i * 2 + 1], top);
    normals.push(0, 0, 1);
  }
  const floorStart = positions.length / 3;
  for (let i = 0; i < vertexCount; i++) {
    positions.push(flat[i * 2], flat[i * 2 + 1], base);
    normals.push(0, 0, -1);
  }
  for (let t = 0; t < triangles.length; t += 3) {
    let [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const cross =
      (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) -
      (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]);
    // earcut does not promise a winding, so face the roof upwards explicitly.
    if (cross < 0) [b, c] = [c, b];
    indices.push(roofStart + a, roofStart + b, roofStart + c);
    indices.push(floorStart + a, floorStart + c, floorStart + b);
  }

  // Walls: one flat-shaded quad per ring edge.
  const height = top - base;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[(i + 1) % ring.length];
      const dx = bx - ax;
      const dy = by - ay;
      const length = Math.hypot(dx, dy);
      if (length === 0 || height <= 0) continue;
      const nx = dy / length;
      const ny = -dx / length;
      const start = positions.length / 3;
      positions.push(ax, ay, base, bx, by, base, bx, by, top, ax, ay, top);
      for (let k = 0; k < 4; k++) normals.push(nx, ny, 0);
      indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    }
  }
}

/** A readable, stable name for a feature's solid, unless `name` is excluded. */
function solidName(feature: Feature, index: number, excludedFields: ReadonlySet<string>): string {
  const name = excludedFields.has("name") ? undefined : feature.properties?.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  if (typeof name === "number") return String(name);
  if (feature.id !== undefined && feature.id !== null) return String(feature.id);
  return `feature_${index + 1}`;
}

/**
 * Build one closed solid per polygon feature of an extruded layer, using the
 * layer's extrusion height, base and colour as MapLibre paints them.
 *
 * @param geojson - The layer's features (non-polygon features are ignored).
 * @param style - The layer style holding the extrusion settings.
 * @param zoom - The zoom that zoom-dependent style expressions evaluate at.
 * @param excludedFields - Attributes the layer excludes from export: styles
 *   still read them, but they are left out of the solids' names and properties.
 * @returns The solids, the local origin and how many flat features were skipped.
 */
export function buildExtrusionModel(
  geojson: FeatureCollection,
  style: LayerStyle,
  zoom = 16,
  excludedFields: ReadonlySet<string> = new Set(),
): ExtrusionModel {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity, Infinity, -Infinity];
  const featurePolygons = geojson.features.map((feature) => {
    const polygons = polygonsOf(feature.geometry);
    extendBounds(bounds, polygons);
    return polygons;
  });
  if (!Number.isFinite(bounds[0])) return { solids: [], origin: [0, 0], skipped: 0 };

  // Centre on the narrower longitude span, so a layer straddling ±180° is
  // centred on the antimeridian rather than on the far side of the globe.
  const crossesAntimeridian = bounds[5] - bounds[4] < bounds[2] - bounds[0];
  const centreLon = crossesAntimeridian
    ? (((bounds[4] + bounds[5]) / 2 + 180) % 360) - 180
    : (bounds[0] + bounds[2]) / 2;
  const origin: [number, number] = [centreLon, (bounds[1] + bounds[3]) / 2];
  const metresPerLon = EARTH_RADIUS * DEG * Math.cos(origin[1] * DEG);
  const metresPerLat = EARTH_RADIUS * DEG;
  const project = (lon: number, lat: number): [number, number] => [
    // Wrap the offset into -180..180 so both sides of ±180° stay adjacent.
    (((((lon - origin[0]) % 360) + 540) % 360) - 180) * metresPerLon,
    (lat - origin[1]) * metresPerLat,
  ];

  const baseValue = styleValue(style, "extrusionBase");
  const base = Number.isFinite(baseValue) ? baseValue : 0;
  const fallbackColor = styleValue(style, "extrusionColor") || style.fillColor || "#3b82f6";
  const readHeight = featureReader(extrusionHeightValue(style), "number", zoom);
  const readColor = featureReader(extrusionColorValue(style), "color", zoom);
  const readFallback = featureReader(fallbackColor, "color", zoom);
  const toLinear = (value: unknown): [number, number, number] | null => {
    if (!isStyleSpecColor(value)) return null;
    const [r, g, b] = (value as unknown as { rgb: [number, number, number, number] }).rgb;
    return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  };
  const fallbackLinear = toLinear(
    readFallback({
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: {},
    }),
  );

  const solids: ExtrudedSolid[] = [];
  let skipped = 0;
  geojson.features.forEach((feature, index) => {
    const polygons = featurePolygons[index];
    if (polygons.length === 0) return;
    const height = Number(readHeight(feature));
    const top = Number.isFinite(height) ? height : 0;
    if (!(top > base)) {
      skipped += 1;
      return;
    }
    const solid: ExtrudedSolid = {
      name: solidName(feature, index, excludedFields),
      color: toLinear(readColor(feature)) ?? fallbackLinear ?? [0.05, 0.22, 0.91],
      properties: Object.fromEntries(
        Object.entries(feature.properties ?? {}).filter(([key]) => !excludedFields.has(key)),
      ),
      positions: [],
      normals: [],
      indices: [],
    };
    for (const polygon of polygons) appendPolygon(solid, polygon, base, top, project);
    if (solid.indices.length > 0) solids.push(solid);
    else skipped += 1;
  });
  return { solids, origin, skipped };
}

/** Rotate a Z-up vector into the Y-up frame glTF and OBJ use. */
function yUp(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y];
}

/** Attribute values that survive JSON serialisation into glTF `extras`. */
function jsonSafe(properties: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(properties)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Encode an extrusion model as binary glTF 2.0: one node per feature (named
 * after it, its attributes in `extras`) under a root node named after the
 * layer, with one material per distinct colour.
 *
 * @param model - The model from {@link buildExtrusionModel}.
 * @param layerName - The root node's name.
 * @returns The `.glb` file bytes.
 */
export function encodeGlb(model: ExtrusionModel, layerName: string): Uint8Array {
  let vertexTotal = 0;
  let indexTotal = 0;
  for (const solid of model.solids) {
    vertexTotal += solid.positions.length / 3;
    indexTotal += solid.indices.length;
  }
  const positions = new Float32Array(vertexTotal * 3);
  const normals = new Float32Array(vertexTotal * 3);
  const indices = new Uint32Array(indexTotal);

  const materials: object[] = [];
  const materialIndex = new Map<string, number>();
  const accessors: object[] = [];
  const meshes: object[] = [];
  const nodes: Record<string, unknown>[] = [];
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const solid of model.solids) {
    const count = solid.positions.length / 3;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      const p = yUp(solid.positions[i * 3], solid.positions[i * 3 + 1], solid.positions[i * 3 + 2]);
      const n = yUp(solid.normals[i * 3], solid.normals[i * 3 + 1], solid.normals[i * 3 + 2]);
      for (let k = 0; k < 3; k++) {
        positions[(vertexOffset + i) * 3 + k] = p[k];
        normals[(vertexOffset + i) * 3 + k] = n[k];
        // Bounds of the stored float32 values, as validators compare them.
        const stored = positions[(vertexOffset + i) * 3 + k];
        min[k] = Math.min(min[k], stored);
        max[k] = Math.max(max[k], stored);
      }
    }
    // Indices are local to the solid's own accessors.
    indices.set(solid.indices, indexOffset);

    const colorKey = solid.color.map((c) => c.toFixed(4)).join(",");
    let material = materialIndex.get(colorKey);
    if (material === undefined) {
      material = materials.length;
      materialIndex.set(colorKey, material);
      materials.push({
        name: `color_${material + 1}`,
        pbrMetallicRoughness: {
          // Opaque on purpose: the map's extrusion opacity (0.8 by default)
          // is a display setting, and a translucent solid is rarely wanted
          // in a modelling or printing tool.
          baseColorFactor: [...solid.color, 1],
          metallicFactor: 0,
          roughnessFactor: 0.9,
        },
      });
    }

    const positionAccessor = accessors.length;
    accessors.push(
      {
        bufferView: 0,
        byteOffset: vertexOffset * 12,
        componentType: 5126,
        count,
        type: "VEC3",
        min,
        max,
      },
      { bufferView: 1, byteOffset: vertexOffset * 12, componentType: 5126, count, type: "VEC3" },
      {
        bufferView: 2,
        byteOffset: indexOffset * 4,
        componentType: 5125,
        count: solid.indices.length,
        type: "SCALAR",
      },
    );
    meshes.push({
      name: solid.name,
      primitives: [
        {
          attributes: { POSITION: positionAccessor, NORMAL: positionAccessor + 1 },
          indices: positionAccessor + 2,
          material,
        },
      ],
    });
    nodes.push({ name: solid.name, mesh: meshes.length - 1, extras: jsonSafe(solid.properties) });
    vertexOffset += count;
    indexOffset += solid.indices.length;
  }
  const childIndices = nodes.map((_, index) => index);
  nodes.push({
    name: layerName,
    children: childIndices,
    extras: { originLongitude: model.origin[0], originLatitude: model.origin[1], units: "metres" },
  });

  const binLength = positions.byteLength + normals.byteLength + indices.byteLength;
  const gltf: Record<string, unknown> = {
    asset: { version: "2.0", generator: "GeoLibre" },
    scene: 0,
    scenes: [{ name: layerName, nodes: [nodes.length - 1] }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews: [
      // Every solid's accessors share these views, so the spec needs the stride.
      {
        buffer: 0,
        byteOffset: 0,
        byteLength: positions.byteLength,
        byteStride: 12,
        target: 34962,
      },
      {
        buffer: 0,
        byteOffset: positions.byteLength,
        byteLength: normals.byteLength,
        byteStride: 12,
        target: 34962,
      },
      {
        buffer: 0,
        byteOffset: positions.byteLength + normals.byteLength,
        byteLength: indices.byteLength,
        target: 34963,
      },
    ],
    buffers: [{ byteLength: binLength }],
  };

  // GLB chunks are 4-byte aligned: JSON pads with spaces, BIN with zeros (and
  // the three typed arrays are already multiples of four bytes).
  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLength = Math.ceil(jsonBytes.length / 4) * 4;
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);
  let offset = 20 + jsonLength;
  view.setUint32(offset, binLength, true);
  view.setUint32(offset + 4, 0x004e4942, true); // "BIN\0"
  offset += 8;
  for (const array of [positions, normals, indices]) {
    out.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offset);
    offset += array.byteLength;
  }
  return out;
}

/**
 * An OBJ-safe object name: whitespace would split the statement, `#` starts a
 * comment, and control characters confuse line-based parsers.
 */
function objName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\s#\u0000-\u001f\u007f]+/g, "_") || "feature";
}

/** Format a number to fixed digits, writing a rounded-to-zero value as "0". */
function fixed(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return Number(text) === 0 ? "0" : text;
}

/**
 * Encode an extrusion model as Wavefront OBJ: one object per feature, Y-up,
 * with each vertex's colour as `v x y z r g b` (read by Blender and MeshLab).
 *
 * @param model - The model from {@link buildExtrusionModel}.
 * @param layerName - Written in the header comment.
 * @returns The `.obj` file text.
 */
export function encodeObj(model: ExtrusionModel, layerName: string): string {
  const lines = [
    `# ${layerName.replace(/[\r\n]+/g, " ")}`,
    "# Exported by GeoLibre. Units: metres, Y up.",
    `# Origin: longitude ${model.origin[0]}, latitude ${model.origin[1]}`,
  ];
  let vertexBase = 1;
  for (const solid of model.solids) {
    lines.push(`o ${objName(solid.name)}`);
    // OBJ vertex colours are conventionally sRGB.
    const rgb = solid.color
      .map((c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055))
      .map((c) => fixed(c, 4))
      .join(" ");
    const count = solid.positions.length / 3;
    for (let i = 0; i < count; i++) {
      const [x, y, z] = yUp(
        solid.positions[i * 3],
        solid.positions[i * 3 + 1],
        solid.positions[i * 3 + 2],
      );
      lines.push(`v ${fixed(x, 3)} ${fixed(y, 3)} ${fixed(z, 3)} ${rgb}`);
    }
    for (let i = 0; i < count; i++) {
      const [x, y, z] = yUp(
        solid.normals[i * 3],
        solid.normals[i * 3 + 1],
        solid.normals[i * 3 + 2],
      );
      lines.push(`vn ${fixed(x, 4)} ${fixed(y, 4)} ${fixed(z, 4)}`);
    }
    for (let t = 0; t < solid.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => solid.indices[t + k] + vertexBase);
      lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
    }
    vertexBase += count;
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Encode an extrusion model as binary STL: every triangle of every feature in
 * one Z-up mesh in metres (STL carries no colours or names).
 *
 * @param model - The model from {@link buildExtrusionModel}.
 * @returns The `.stl` file bytes.
 */
export function encodeStl(model: ExtrusionModel): Uint8Array {
  const triangleCount = model.solids.reduce((sum, solid) => sum + solid.indices.length / 3, 0);
  const out = new Uint8Array(84 + triangleCount * 50);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode("GeoLibre extrusion model, metres, Z up").subarray(0, 80));
  view.setUint32(80, triangleCount, true);
  let offset = 84;
  for (const solid of model.solids) {
    const { positions, normals, indices } = solid;
    for (let t = 0; t < indices.length; t += 3) {
      // Flat shading: every vertex of a triangle shares the face normal.
      const first = indices[t] * 3;
      for (let k = 0; k < 3; k++) view.setFloat32(offset + k * 4, normals[first + k], true);
      offset += 12;
      for (let v = 0; v < 3; v++) {
        const index = indices[t + v] * 3;
        for (let k = 0; k < 3; k++) view.setFloat32(offset + k * 4, positions[index + k], true);
        offset += 12;
      }
      offset += 2; // attribute byte count, left zero
    }
  }
  return out;
}
