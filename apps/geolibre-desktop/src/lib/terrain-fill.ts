/**
 * Whether a custom terrain DEM should be surrounded by the global terrain.
 *
 * The saved preference wins when there is one. Otherwise the default depends
 * on where the DEM comes from (#3470): a DEM read from an HTTP(S) URL is already
 * online, so filling around it from the public global tiles costs nothing new,
 * while a local file is kept off the network unless the user turns it on.
 *
 * @param saved - The project's `terrainFillOutside`, if set.
 * @param source - The DEM being applied: a URL, a local file, or null.
 * @returns Whether to fill outside the DEM.
 */
export function resolveTerrainFillOutside(
  saved: boolean | undefined,
  source: string | Blob | null,
): boolean {
  if (saved !== undefined) return saved;
  return typeof source === "string" && /^https?:\/\//i.test(source.trim());
}

/**
 * The fill the Terrain dialog shows when it opens.
 *
 * With a DEM on the map this is what the engine is doing for it. With none yet
 * there is no source to judge by, so it shows the saved choice or the default
 * for a URL DEM, the common case; a local file opened next still resolves to
 * off through {@link resolveTerrainFillOutside} unless the box is set.
 *
 * @param engineFill - The engine's fill for the DEM on the map, or null when
 *   there is none (or the engine cannot fill).
 * @param saved - The project's `terrainFillOutside`, if set.
 * @returns Whether the checkbox starts checked.
 */
export function displayedTerrainFillOutside(
  engineFill: boolean | null,
  saved: boolean | undefined,
): boolean {
  return engineFill ?? saved ?? true;
}
