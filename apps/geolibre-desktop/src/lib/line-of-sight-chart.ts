import { FEET_PER_METER, METERS_PER_MILE } from "@geolibre/core";
import { buildChartGeometry } from "@geolibre/plugins/elevation-profile-chart";
import type { LineOfSightResult } from "@geolibre/processing";
import type { TFunction } from "i18next";

/**
 * Pure helpers behind the Line of Sight panel (issue #2858): height parsing,
 * unit formatting, and the profile chart's geometry, kept out of the component
 * so they can be tested without rendering it.
 */

/** Largest height above ground the inputs accept, in metres. */
export const MAX_HEIGHT_METERS = 10_000;

/** Parse a height input, falling back to `fallback` for anything unusable. */
export function parseHeight(value: string, fallback: number): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_HEIGHT_METERS, Math.max(0, parsed));
}

/** Formats lengths and elevations in the scale bar's unit system. */
export interface UnitFormatter {
  distance(meters: number): string;
  elevation(meters: number): string;
}

/**
 * Length and elevation formatting in the scale bar's unit system.
 *
 * @param imperial - Feet and miles instead of metres and kilometres.
 * @param language - The locale numbers are formatted in.
 * @param t - Translates the unit abbreviations.
 * @returns The formatter.
 */
export function unitFormatter(imperial: boolean, language: string, t: TFunction): UnitFormatter {
  const number = (value: number, digits: number) =>
    new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(value);
  return {
    distance(meters) {
      if (imperial) {
        return meters >= METERS_PER_MILE
          ? `${number(meters / METERS_PER_MILE, 2)} ${t("quickAnalysis.unit.miles")}`
          : `${number(meters * FEET_PER_METER, 0)} ${t("quickAnalysis.unit.feet")}`;
      }
      return meters >= 1000
        ? `${number(meters / 1000, 2)} ${t("quickAnalysis.unit.kilometers")}`
        : `${number(meters, 0)} ${t("quickAnalysis.unit.meters")}`;
    },
    elevation(meters) {
      return imperial
        ? `${number(meters * FEET_PER_METER, 0)} ${t("quickAnalysis.unit.feet")}`
        : `${number(meters, 0)} ${t("quickAnalysis.unit.meters")}`;
    },
  };
}

export const CHART_WIDTH = 320;
export const CHART_HEIGHT = 120;
export const CHART_PADDING = { top: 8, right: 8, bottom: 16, left: 44 };
/** Most vertices one chart path gets; a 4096-sample profile is thinned to this. */
export const CHART_MAX_POINTS = 400;

/**
 * The profile chart's drawable model, built with the elevation-profile
 * plugin's chart geometry: the ground thinned to at most
 * {@link CHART_MAX_POINTS} vertices, split into runs of one visibility, and
 * the sight line, all as SVG point lists on a y axis that also covers the
 * sight line.
 *
 * @param result - The computed line of sight.
 * @returns The thinned samples, the chart geometry, the ground runs, and the
 *   sight line's points.
 */
export function lineOfSightChartModel(result: LineOfSightResult) {
  const stride = Math.max(1, Math.ceil(result.samples.length / CHART_MAX_POINTS));
  const samples = result.samples.filter(
    (sample, index) =>
      Number.isFinite(sample.elevation) &&
      // Thinned to every stride-th sample, keeping the end and every
      // visibility change so a short hidden run still shows.
      (index % stride === 0 ||
        index === result.samples.length - 1 ||
        sample.visible !== result.samples[index - 1]?.visible),
  );
  const sightlines = samples.map((sample) => sample.sightline);
  const geometry = buildChartGeometry(
    samples.map(({ distance, elevation }) => ({ distance, elevation })),
    CHART_WIDTH,
    CHART_HEIGHT,
    CHART_PADDING,
    [Math.min(...sightlines), Math.max(...sightlines)],
  );
  const point = (distance: number, elevation: number) =>
    `${geometry.xScale(distance).toFixed(1)},${geometry.yScale(elevation).toFixed(1)}`;
  // Ground runs of one visibility, sharing their boundary sample.
  const runs: { visible: boolean; points: string }[] = [];
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const last = runs.at(-1);
    if (last && last.visible === sample.visible) {
      last.points += ` ${point(sample.distance, sample.elevation)}`;
    } else {
      const previous = samples[i - 1];
      runs.push({
        visible: sample.visible,
        points: `${previous ? `${point(previous.distance, previous.elevation)} ` : ""}${point(sample.distance, sample.elevation)}`,
      });
    }
  }
  const sightline = samples.map((sample) => point(sample.distance, sample.sightline)).join(" ");
  return { samples, geometry, runs, sightline };
}
