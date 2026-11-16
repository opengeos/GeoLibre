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
