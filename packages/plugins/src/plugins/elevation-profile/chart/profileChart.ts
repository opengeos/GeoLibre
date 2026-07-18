/**
 * Pure geometry for the inline SVG elevation chart.
 *
 * Given profile samples and a drawing area, this module computes the SVG path
 * strings, axis scales, and a pixel-to-index lookup for hover interaction. It
 * has no DOM dependencies: the control renders the returned values into SVG
 * elements, and the math is unit-tested on its own.
 */

/** A single point on the profile: distance along the line and its elevation. */
export interface ProfilePoint {
  /** Distance from the start of the line in meters. */
  distance: number;
  /** Elevation at that distance in meters. */
  elevation: number;
}

/** Inner padding (in pixels) between the chart edges and the plotted area. */
export interface ChartPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const DEFAULT_PADDING: ChartPadding = { top: 8, right: 8, bottom: 18, left: 36 };

/** Computed chart geometry ready to render and to drive hover interaction. */
export interface ChartGeometry {
  width: number;
  height: number;
  padding: ChartPadding;
  /** SVG `d` for the elevation line (stroke). */
  linePath: string;
  /** SVG `d` for the filled area beneath the line. */
  areaPath: string;
  /** Map a distance (meters) to an x pixel coordinate. */
  xScale(distance: number): number;
  /** Map an elevation (meters) to a y pixel coordinate. */
  yScale(elevation: number): number;
  /** Nearest sample index for an x pixel coordinate (clamped to the data range). */
  indexForX(px: number): number;
  minElevation: number;
  maxElevation: number;
  totalDistance: number;
}

/**
 * Build the chart geometry for a set of profile points.
 *
 * @param points - Profile samples in along-line order (distance ascending)
 * @param width - Chart width in pixels
 * @param height - Chart height in pixels
 * @param padding - Optional inner padding; sensible defaults are used otherwise
 * @returns The {@link ChartGeometry} describing scales, paths, and hover lookup
 */
export function buildChartGeometry(
  points: ProfilePoint[],
  width: number,
  height: number,
  padding: ChartPadding = DEFAULT_PADDING,
): ChartGeometry {
  const plotWidth = Math.max(1, width - padding.left - padding.right);
  const plotHeight = Math.max(1, height - padding.top - padding.bottom);
  const bottomY = padding.top + plotHeight;

  const distances = points.map((p) => p.distance);
  const elevations = points.map((p) => p.elevation);
  const totalDistance = distances.length ? distances[distances.length - 1] : 0;

  const minElevation = elevations.length ? Math.min(...elevations) : 0;
  const maxElevation = elevations.length ? Math.max(...elevations) : 0;
  const elevationRange = maxElevation - minElevation;

  const xScale = (distance: number): number => {
    if (totalDistance === 0) return padding.left;
    return padding.left + (distance / totalDistance) * plotWidth;
  };

  const yScale = (elevation: number): number => {
    // Flat profile: center the line vertically to avoid divide-by-zero.
    if (elevationRange === 0) return padding.top + plotHeight / 2;
    return padding.top + (1 - (elevation - minElevation) / elevationRange) * plotHeight;
  };

  const indexForX = (px: number): number => {
    if (points.length === 0) return -1;
    if (points.length === 1) return 0;
    const clamped = Math.min(padding.left + plotWidth, Math.max(padding.left, px));
    const targetDistance =
      totalDistance === 0 ? 0 : ((clamped - padding.left) / plotWidth) * totalDistance;

    // Distances are ascending, so find the closest sample by linear scan.
    let nearest = 0;
    let nearestDelta = Infinity;
    for (let i = 0; i < distances.length; i += 1) {
      const delta = Math.abs(distances[i] - targetDistance);
      if (delta < nearestDelta) {
        nearestDelta = delta;
        nearest = i;
      }
    }
    return nearest;
  };

  let linePath = "";
  for (let i = 0; i < points.length; i += 1) {
    const x = xScale(points[i].distance);
    const y = yScale(points[i].elevation);
    linePath += `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    if (i < points.length - 1) linePath += " ";
  }

  let areaPath = "";
  if (points.length > 0) {
    const firstX = xScale(points[0].distance);
    const lastX = xScale(points[points.length - 1].distance);
    areaPath =
      `${linePath} L${lastX.toFixed(2)} ${bottomY.toFixed(2)}` +
      ` L${firstX.toFixed(2)} ${bottomY.toFixed(2)} Z`;
  }

  return {
    width,
    height,
    padding,
    linePath,
    areaPath,
    xScale,
    yScale,
    indexForX,
    minElevation,
    maxElevation,
    totalDistance,
  };
}
