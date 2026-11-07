import type { IndoorGmlParseResult } from "./indoorgml";

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

export type IndoorGmlCrsOrigin = "explicit" | "detected" | "sample" | null;
export type IndoorGmlLocalOrigin = "explicit" | "auto" | null;

export interface IndoorGmlCrsState {
  sourceCrs: string;
  sourceCrsOrigin: IndoorGmlCrsOrigin;
  local: boolean;
  localOrigin?: IndoorGmlLocalOrigin;
}

/**
 * Update the IndoorGML dialog's CRS and local-coordinates state when a file is
 * parsed. A CRS the user typed or picked from the preset menu (`"explicit"`) is
 * kept when the new file names no CRS; a CRS detected from an earlier file or
 * filled by a sample is cleared so a CRS-less file is not reprojected with the
 * previous file's CRS and can auto-enable local coordinates. An auto-enabled
 * `local` flag is also reset when a subsequent CRS-less file looks geographic.
 *
 * @param current - The current CRS and local-coordinates state.
 * @param parsed - The parsed IndoorGML file's CRS and coordinate bounds summary.
 * @returns The next CRS and local-coordinates state.
 */
export function adoptIndoorGmlDetectedCrs(
  current: IndoorGmlCrsState,
  parsed: Pick<IndoorGmlParseResult, "detectedCrs" | "coordinatesLookGeographic">,
): IndoorGmlCrsState {
  if (parsed.detectedCrs) {
    return {
      sourceCrs: parsed.detectedCrs,
      sourceCrsOrigin: "detected",
      local: false,
      localOrigin: null,
    };
  }
  const explicitCrs = current.sourceCrsOrigin === "explicit" ? current.sourceCrs : "";
  const explicitLocal = current.localOrigin === "explicit" && current.local;
  const autoLocal = !parsed.coordinatesLookGeographic && !explicitCrs.trim();
  return {
    sourceCrs: explicitCrs,
    sourceCrsOrigin: explicitCrs ? "explicit" : null,
    local: explicitLocal || autoLocal,
    localOrigin: explicitLocal ? "explicit" : autoLocal ? "auto" : null,
  };
}
