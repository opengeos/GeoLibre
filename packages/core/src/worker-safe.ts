// `@geolibre/core/worker-safe`: the store-free helpers the client-side
// processing tools use, for code that runs in a Web Worker.
//
// The package root re-exports the Zustand store and everything else in core, so
// a worker importing a single helper from it bundled all of that (the Turf tool
// worker was ~0.9 MB, most of it unused). These modules have no store, DOM or
// map dependencies. Everything here is also exported from the package root, and
// both paths resolve to the same module instances, so module state (the active
// planetary body) is shared between them on the main thread.
export type { GeoLibreLayer } from "./types";
export {
  bodyLengthToEarth,
  earthLengthToBody,
  getActiveBodyRadiusRatio,
  getActiveEllipsoid,
  setActiveEllipsoidId,
} from "./ellipsoids";
export { decodePolyline, decodePolylineDetailed, encodePolyline } from "./polyline";
export { horizontalBbox } from "./geojson-z";
export { layerJoinKey } from "./joins";
// Project History's compare view parses and diffs projects off the main thread.
export type { GeoLibreProject } from "./types";
export { parseProject } from "./project";
export { diffProjects, type ProjectDiff } from "./project-diff";
