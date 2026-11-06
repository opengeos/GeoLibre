/**
 * How IndoorGML cells are drawn (issue #3341): one colour per kind of space,
 * so rooms, corridors and stairs, doors and anchors read apart.
 */

/** Cell colours by IndoorGML space type (the `kind` property). */
const CELL_KIND_COLORS: [string, string][] = [
  ["GeneralSpace", "#93c5fd"],
  ["TransitionSpace", "#fcd34d"],
  ["ConnectionSpace", "#f87171"],
  ["AnchorSpace", "#6ee7b7"],
  ["NonNavigableSpace", "#d1d5db"],
];

/**
 * A MapLibre `match` on a cell's `kind`.
 *
 * @param fallback - The colour of a plain `CellSpace` or any other kind.
 * @returns The expression.
 */
export function indoorGmlCellColorExpression(fallback: string): unknown[] {
  const match: unknown[] = ["match", ["get", "kind"]];
  for (const [kind, color] of CELL_KIND_COLORS) match.push(kind, color);
  match.push(fallback);
  return match;
}
