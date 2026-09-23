// The `mgrs` package (also a dependency of proj4) ships no type declarations.
// Only the two functions the satellite-embeddings grids use are declared.
declare module "mgrs" {
  /** Converts `[lon, lat]` to an MGRS reference with `accuracy` digits per axis. */
  export function forward(lonLat: [number, number], accuracy?: number): string;
  /** Converts an MGRS reference to its `[west, south, east, north]` box. */
  export function inverse(reference: string): [number, number, number, number];
}
