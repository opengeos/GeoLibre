export type TileScheme = "xyz" | "tms";

/** A layer record that carries a tile scheme. Only XYZ templates are rewritten. */
export interface TileAddressLayer {
  type?: string;
  source?: { scheme?: unknown };
}

/** `"tms"` is the only scheme that flips a row. Anything else is XYZ. */
export function asTileScheme(scheme: unknown): TileScheme {
  return scheme === "tms" ? "tms" : "xyz";
}

/**
 * Express a `{-y}` row flip in the form MapLibre understands.
 *
 * `{-y}` flips the row. It does not select TMS. `scheme: "tms"` is its own
 * flip, so a template that has both is requested with an XYZ row. The stored
 * template and scheme stay as the user wrote them; callers apply this when
 * they build a render source. A template may use `{y}` or `{-y}`, not both,
 * and every template in one list must use the same row token. One shared
 * scheme applies to the whole list, so a plain `{y}` template cannot sit
 * beside a `{-y}` template.
 */
export function resolveTileAddress(
  tiles: readonly string[],
  scheme: TileScheme = "xyz",
): { tiles: string[]; scheme: TileScheme } {
  let flipped = false;
  let plain = false;
  const next = tiles.map((tile) => {
    const flipY = tile.includes("{-y}");
    const plainY = tile.includes("{y}");
    if (flipY && plainY) {
      throw new Error("A tile template can use {y} or {-y}, not both.");
    }
    if (flipY) flipped = true;
    if (plainY) plain = true;
    return flipY ? tile.replaceAll("{-y}", "{y}") : tile;
  });
  if (flipped && plain) {
    throw new Error("A tile list can use {y} or {-y}, not both.");
  }
  const nextScheme: TileScheme = flipped ? (scheme === "tms" ? "xyz" : "tms") : scheme;
  return { tiles: next, scheme: nextScheme };
}

/**
 * The row a layer's templates should request.
 *
 * XYZ layers run through {@link resolveTileAddress}. Every other layer keeps
 * its templates and only normalizes `scheme`.
 */
export function resolveLayerTileAddress(
  layer: TileAddressLayer,
  tiles: readonly string[],
): { tiles: string[]; scheme: TileScheme } {
  const scheme = asTileScheme(layer.source?.scheme);
  if (layer.type !== "xyz") return { tiles: [...tiles], scheme };
  return resolveTileAddress(tiles, scheme);
}

/** True when {@link resolveTileAddress} rejected a mixed `{y}` / `{-y}` template. */
export function isTileAddressError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("{y} or {-y}");
}
