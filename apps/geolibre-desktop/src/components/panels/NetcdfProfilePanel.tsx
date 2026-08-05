import { Button } from "@geolibre/ui";
import { useId, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { resolveChartDomain } from "../../lib/chart-domain";
import { displayUnits } from "../../lib/netcdf-image-symbology";
import {
  clearNetcdfProfileReadings,
  getNetcdfProfileReadings,
  subscribeNetcdfProfileReadings,
  type NetcdfProfileReading,
} from "../../lib/netcdf-profile-store";

// Matches the Time Slider's pixel chart so the two read as one family.
const SERIES_COLORS = [
  "hsl(var(--primary))",
  "hsl(12 76% 61%)",
  "hsl(173 58% 39%)",
  "hsl(262 52% 56%)",
  "hsl(43 74% 49%)",
  "hsl(199 89% 48%)",
];

const CHART_W = 560;
const CHART_H = 260;
const MARGIN = { top: 12, right: 12, bottom: 40, left: 56 };
const INNER_W = CHART_W - MARGIN.left - MARGIN.right;
const INNER_H = CHART_H - MARGIN.top - MARGIN.bottom;
const AXIS = "hsl(var(--border))";
const TICK = "hsl(var(--muted-foreground))";

/**
 * Format an axis value compactly, dropping noise digits on large magnitudes.
 *
 * Deliberately coarser than `formatReading` in `useNetcdfIdentify`, which is the
 * readout for one pixel the user asked about and so keeps full precision. These
 * are tick labels on a 560px-wide chart, where a 6-decimal number would collide
 * with its neighbour.
 */
function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e6 || abs <= 1e-3)) return value.toExponential(1);
  return Number(value.toFixed(abs >= 100 ? 0 : 3)).toString();
}

/**
 * The x-axis positions for a reading: the axis' own coordinate values when the
 * file has them (wavelengths in nm), else the bare index.
 */
function axisPositions(reading: NetcdfProfileReading): number[] {
  const { axis, values } = reading.profile;
  if (axis.values && axis.values.length === values.length) return axis.values;
  return values.map((_, index) => index);
}

/**
 * Spectral signature of the pixels sampled with Identify on a NetCDF cube: one
 * line per clicked point, value against the cube's own band axis.
 *
 * Plots against the axis' coordinate values where the file provides them, so a
 * hyperspectral cube reads as reflectance against wavelength in nm rather than
 * against a band number. Fill readings break the line instead of dropping it to
 * the nodata value.
 *
 * Renders nothing until a pixel has been sampled, so it costs nothing for the
 * (common) 2-D grid that has no band axis to profile.
 *
 * @param props.layerId - The layer whose readings to chart; readings sampled
 *   from any other layer are ignored, so selecting a second NetCDF layer does
 *   not show the first one's spectra under the second one's heading.
 * @returns The chart, or null when this layer has no sampled pixel.
 */
export function NetcdfProfilePanel({ layerId }: { layerId: string }) {
  const { t } = useTranslation();
  const clipId = `${useId()}-plot`;
  const allReadings = useSyncExternalStore(
    subscribeNetcdfProfileReadings,
    getNetcdfProfileReadings,
    getNetcdfProfileReadings,
  );
  const readings = allReadings.filter((reading) => reading.layerId === layerId);

  if (readings.length === 0) return null;

  const values = readings.flatMap((reading) =>
    reading.profile.values.filter((value): value is number => value !== null),
  );
  if (values.length === 0) return null;

  const { min, max } = resolveChartDomain(values, { min: null, max: null });
  const positions = readings.flatMap(axisPositions);
  const xMin = Math.min(...positions);
  const xMax = Math.max(...positions);
  const xSpan = xMax - xMin || 1;

  const scaleX = (position: number) => MARGIN.left + ((position - xMin) / xSpan) * INNER_W;
  const scaleY = (value: number) => MARGIN.top + INNER_H - ((value - min) / (max - min)) * INNER_H;

  const first = readings[0];
  // Through `displayUnits` like the value label below: a coordinate variable can
  // declare `unitless`/`1`/`n/a`, and "wavelength (1)" is noise on an axis.
  const axisUnits = displayUnits(first.profile.axis.units);
  const axisLabel = axisUnits
    ? `${first.profile.axis.name} (${axisUnits})`
    : first.profile.axis.name;
  const valueUnits = displayUnits(first.units);
  const valueLabel = valueUnits ? `${first.variable} (${valueUnits})` : first.variable;

  return (
    <div className="space-y-2 border-t p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold">{t("netcdfProfile.heading")}</p>
        <Button type="button" variant="ghost" size="sm" onClick={clearNetcdfProfileReadings}>
          {t("netcdfProfile.clear")}
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">{valueLabel}</p>

      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        width="100%"
        role="img"
        aria-label={t("netcdfProfile.chartAria")}
      >
        <defs>
          {/* Scopes the clip to this chart, so a second instance cannot clip
              against the first's rect. */}
          <clipPath id={clipId}>
            <rect x={MARGIN.left} y={MARGIN.top} width={INNER_W} height={INNER_H} />
          </clipPath>
        </defs>

        <line
          x1={MARGIN.left}
          y1={MARGIN.top}
          x2={MARGIN.left}
          y2={MARGIN.top + INNER_H}
          stroke={AXIS}
        />
        <line
          x1={MARGIN.left}
          y1={MARGIN.top + INNER_H}
          x2={MARGIN.left + INNER_W}
          y2={MARGIN.top + INNER_H}
          stroke={AXIS}
        />

        <text
          x={MARGIN.left - 6}
          y={MARGIN.top}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={10}
          fill={TICK}
        >
          {formatValue(max)}
        </text>
        <text
          x={MARGIN.left - 6}
          y={MARGIN.top + INNER_H}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={10}
          fill={TICK}
        >
          {formatValue(min)}
        </text>

        {[xMin, (xMin + xMax) / 2, xMax].map((position, index) => (
          <text
            key={index}
            x={scaleX(position)}
            y={MARGIN.top + INNER_H + 14}
            textAnchor={index === 0 ? "start" : index === 2 ? "end" : "middle"}
            fontSize={10}
            fill={TICK}
          >
            {formatValue(position)}
          </text>
        ))}
        <text
          x={MARGIN.left + INNER_W / 2}
          y={CHART_H - 6}
          textAnchor="middle"
          fontSize={10}
          fill={TICK}
        >
          {axisLabel}
        </text>

        <g clipPath={`url(#${clipId})`}>
          {readings.map((reading, index) => {
            const xs = axisPositions(reading);
            // Break the path at every fill reading, so a gap shows as a gap
            // rather than a line drawn through the nodata value.
            const segments: string[] = [];
            let current: string[] = [];
            reading.profile.values.forEach((value, i) => {
              if (value === null) {
                if (current.length > 1) segments.push(current.join(" "));
                current = [];
                return;
              }
              current.push(`${current.length === 0 ? "M" : "L"}${scaleX(xs[i])} ${scaleY(value)}`);
            });
            if (current.length > 1) segments.push(current.join(" "));
            return (
              <path
                key={`${reading.lng},${reading.lat},${index}`}
                d={segments.join(" ")}
                fill="none"
                stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                strokeWidth={1.25}
              />
            );
          })}
        </g>
      </svg>

      <ul className="space-y-0.5">
        {readings.map((reading, index) => (
          <li
            key={`${reading.lng},${reading.lat},${index}`}
            className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
          >
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length] }}
            />
            {reading.lng.toFixed(4)}, {reading.lat.toFixed(4)}
          </li>
        ))}
      </ul>
    </div>
  );
}
