export type TileScheme = "xyz" | "tms";

/**
 * Express a `{-y}` row flip in the form MapLibre understands.
 *
 * `{-y}` flips the row. It does not select TMS. `scheme: "tms"` is its own
 * flip, so a template that has both is requested with an XYZ row. The stored
 * template and scheme stay as the user wrote them; callers apply this when
 * they build a render source. A template may use `{y}` or `{-y}`, not both.
 */
export function resolveTileAddress(
  tiles: readonly string[],
  scheme: TileScheme = "xyz",
): { tiles: string[]; scheme: TileScheme } {
  let flipped = false;
  const next = tiles.map((tile) => {
    if (!tile.includes("{-y}")) return tile;
    if (tile.includes("{y}")) {
      throw new Error("A tile template can use {y} or {-y}, not both.");
    }
    flipped = true;
    return tile.replaceAll("{-y}", "{y}");
  });
  const nextScheme: TileScheme = flipped ? (scheme === "tms" ? "xyz" : "tms") : scheme;
  return { tiles: next, scheme: nextScheme };
}
