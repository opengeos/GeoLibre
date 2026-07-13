// Equirectangular (plate carrée, EPSG:4326) → Web-Mercator (EPSG:3857) tile
// reprojection for planetary raster mosaics.
//
// GeoLibre's Mars and Moon basemaps come from OpenPlanetaryMap, which publishes
// ready Web-Mercator tiles. The other USGS Astrogeology bodies (Mercury, Venus,
// the Galilean moons, Titan, Pluto, Charon) are only served as *equirectangular*
// WMS layers — MapLibre can't render those directly, because it only draws Web
// Mercator. This module warps a single equirectangular WMS image into the Web-
// Mercator tile MapLibre asks for.
//
// The warp is cheap because both projections are **linear in longitude**: a tile
// and the WMS window requested for it share the same longitude span, so columns
// map 1:1 and only the latitude axis is non-linear. We therefore request one WMS
// GetMap covering exactly the tile's lon/lat bbox and resample it row-by-row
// (nearest-neighbour) onto the Mercator latitude grid — no per-pixel trig, just
// `size` latitude evaluations and `size` row copies per tile.

/** Radians → degrees. */
const DEG = 180 / Math.PI;

/**
 * Web-Mercator latitude (degrees) at normalized vertical position `t ∈ [0, 1]`,
 * where `t = 0` is the top of the Mercator world (≈ +85.051°) and `t = 1` the
 * bottom (≈ −85.051°). This is the inverse of the Web-Mercator Y projection.
 */
export function mercatorLatDeg(t: number): number {
  return DEG * Math.atan(Math.sinh(Math.PI * (1 - 2 * t)));
}

export interface TileCoords {
  z: number;
  x: number;
  y: number;
}

/** Longitude/latitude bounds (degrees) of a Web-Mercator XYZ tile. */
export interface TileGeoBounds {
  lonW: number;
  lonE: number;
  latN: number;
  latS: number;
}

/** Geographic bounds (degrees) of a Web-Mercator XYZ tile. */
export function tileGeoBounds({ z, x, y }: TileCoords): TileGeoBounds {
  const n = 2 ** z;
  return {
    lonW: (x / n) * 360 - 180,
    lonE: ((x + 1) / n) * 360 - 180,
    latN: mercatorLatDeg(y / n),
    latS: mercatorLatDeg((y + 1) / n),
  };
}

/**
 * The WMS `BBOX` string for a tile, in **WMS 1.1.1 / SRS=EPSG:4326** axis order
 * (`minLon,minLat,maxLon,maxLat`). Requesting this window at `size × size` px
 * yields an equirectangular image whose top row is `latN` and whose columns are
 * the tile's columns 1:1 — exactly what {@link remapRowsToMercator} expects.
 */
export function wmsBboxFor(bounds: TileGeoBounds): string {
  return `${bounds.lonW},${bounds.latS},${bounds.lonE},${bounds.latN}`;
}

/**
 * Remap an equirectangular source image (covering exactly the tile's lon/lat
 * bbox, row 0 = `latN`, linear in latitude) onto the Web-Mercator tile grid.
 * Columns map 1:1 (both projections are linear in longitude); rows are resampled
 * nearest-neighbour along the non-linear Mercator latitude axis.
 *
 * @param src   RGBA bytes, length `size*size*4`, top row at `latN`.
 * @param size  Tile edge length in pixels (typically 256).
 * @param tile  The Web-Mercator tile being produced.
 * @param bounds The tile's geographic bounds (also the source image's extent).
 * @returns RGBA bytes for the Mercator tile, same dimensions as the source.
 */
export function remapRowsToMercator(
  src: Uint8Array,
  size: number,
  tile: TileCoords,
  bounds: TileGeoBounds,
): Uint8Array {
  const { latN, latS } = bounds;
  const span = latN - latS;
  const n = 2 ** tile.z;
  const rowBytes = size * 4;
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    // Latitude at the centre of output row py, via the inverse Mercator Y.
    const lat = mercatorLatDeg((tile.y + (py + 0.5) / size) / n);
    // Source row (row 0 = latN, linear in latitude). Clamp to the image; a
    // degenerate (zero-height) span collapses to the first row.
    let srcRow = span > 0 ? Math.floor(((latN - lat) / span) * size) : 0;
    if (srcRow < 0) srcRow = 0;
    else if (srcRow >= size) srcRow = size - 1;
    const from = srcRow * rowBytes;
    out.set(src.subarray(from, from + rowBytes), py * rowBytes);
  }
  return out;
}
