/** Public Tileset3D fields used to move both its geometry and culling bounds. */
export interface PositionedTileset {
  cartographicCenter?: ArrayLike<number> | null;
  modelMatrix?: { clone(): { translate(offset: number[]): PositionedTileset["modelMatrix"] } };
  selectTiles?: () => Promise<unknown>;
}

/** Translate along the WGS84 surface normal, in Earth-centered coordinates. */
export function applyTilesetAltitudeOffset(tileset: PositionedTileset, offset: number): void {
  const center = tileset.cartographicCenter;
  if (!center || !tileset.modelMatrix || !Number.isFinite(offset) || offset === 0) return;
  const longitude = (center[0] * Math.PI) / 180;
  const latitude = (center[1] * Math.PI) / 180;
  // Clone: loaders.gl's default identity matrix can be shared across tilesets.
  tileset.modelMatrix = tileset.modelMatrix
    .clone()
    .translate([
      offset * Math.cos(latitude) * Math.cos(longitude),
      offset * Math.cos(latitude) * Math.sin(longitude),
      offset * Math.sin(latitude),
    ]);
  // Re-traverse after changing the transform, including on a stationary camera
  // during project restore. Moving only rendered sublayers leaves culling at
  // the original elevation and makes a lowered tileset disappear when zoomed in.
  void tileset.selectTiles?.();
}
