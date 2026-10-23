// Vite's `?raw` suffix imports a file's text as a string (map-crs.ts reads
// proj4's UMD build this way to hand it to MapLibre's workers).
declare module "proj4/dist/proj4.js?raw" {
  const source: string;
  export default source;
}
