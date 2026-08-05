import { Button } from "@geolibre/ui";
import { Download, Image as ImageIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveChartDomain } from "../../lib/chart-domain";
import { downloadChartPng, triggerDownload } from "../../lib/chart-export";
import { displayUnits } from "../../lib/netcdf-image-symbology";
import {
  buildNetcdfProfileCsv,
  netcdfAxisPositions,
  netcdfSeriesColor,
  niceTickValues,
} from "../../lib/netcdf-profile-series";
import type { NetcdfProfileSample } from "../../lib/netcdf-profile-store";
import { sanitizeExportFileName } from "../../lib/vector-export";

/** Chart geometry. Fixed, and scaled to the container by the SVG viewBox, so a
 * resized window magnifies the whole chart rather than reflowing it — and the
 * PNG export has a resolution to render at without measuring the DOM. */
const CHART_W = 560;
const CHART_H = 260;
const MARGIN = { top: 12, right: 12, bottom: 40, left: 56 };
const INNER_W = CHART_W - MARGIN.left - MARGIN.right;
const INNER_H = CHART_H - MARGIN.top - MARGIN.bottom;
const AXIS = "hsl(var(--border))";
const TICK = "hsl(var(--muted-foreground))";
/** Roughly how many x-axis labels to aim for. Eight fits without crowding at
 * this width, and is enough to locate a feature on a wavelength axis. */
const X_TICK_TARGET = 8;

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
 * The spectral profile itself: the plotted lines, the export buttons, and the
 * list of sampled points.
 *
 * Shared by the docked section in the Style panel and the floating window, which
 * differ only in their header and in how much room they give the chart.
 *
 * Plots against the axis' coordinate values where the file provides them, so a
 * hyperspectral cube reads as reflectance against wavelength in nm rather than
 * against a band number. Fill readings break the line instead of dropping it to
 * the nodata value.
 *
 * @param props.samples - The sampled pixels, charted in list order. Points whose
 *   profile has not resolved (or that came from a 2-D grid) still appear in the
 *   list, matching their marker on the map; they just draw no line.
 * @param props.chartClassName - Sizing for the chart's box, so the window can
 *   let it fill the remaining height while the docked panel fixes it.
 * @returns The chart body.
 */
export function NetcdfProfileChart({
  samples,
  chartClassName = "h-44",
}: {
  samples: NetcdfProfileSample[];
  chartClassName?: string;
}) {
  const { t } = useTranslation();
  const clipId = `${useId()}-plot`;
  const chartRef = useRef<HTMLDivElement | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const charted = samples.filter(
    (sample): sample is NetcdfProfileSample & { profile: NonNullable<typeof sample.profile> } =>
      sample.profile !== undefined,
  );
  const values = charted.flatMap((sample) =>
    sample.profile.values.filter((value): value is number => value !== null),
  );
  const hasChart = values.length > 0;

  const first = charted[0];
  const valueUnits = first ? displayUnits(first.units) : undefined;
  const valueLabel = first
    ? valueUnits
      ? `${first.variable} (${valueUnits})`
      : first.variable
    : "";

  const exportBase = sanitizeExportFileName(`${first?.variable ?? "netcdf"}-spectral-profile`);

  const downloadPng = () => {
    const svg = chartRef.current?.querySelector("svg");
    if (!svg) return;
    setExportError(null);
    // Rasterization is async (image load + canvas), so surface a rejection
    // rather than letting it become an unhandled promise.
    downloadChartPng(svg, CHART_W, CHART_H, `${exportBase}.png`).catch((error: unknown) =>
      setExportError(error instanceof Error ? error.message : t("netcdfProfile.exportError")),
    );
  };

  const downloadCsv = () => {
    const csv = buildNetcdfProfileCsv(samples);
    if (!csv) return;
    setExportError(null);
    try {
      triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${exportBase}.csv`);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : t("netcdfProfile.exportError"));
    }
  };

  // Only computed when there is something to plot; the guards above keep the
  // domain and scales away from an empty value set.
  let body: React.ReactNode = (
    <p className="text-[10px] text-muted-foreground">{t("netcdfProfile.noValues")}</p>
  );
  if (hasChart) {
    const { min, max } = resolveChartDomain(values, { min: null, max: null });
    const positions = charted.flatMap(netcdfAxisPositions);
    const xMin = Math.min(...positions);
    const xMax = Math.max(...positions);
    const xSpan = xMax - xMin || 1;
    const scaleX = (position: number) => MARGIN.left + ((position - xMin) / xSpan) * INNER_W;
    const scaleY = (value: number) =>
      MARGIN.top + INNER_H - ((value - min) / (max - min || 1)) * INNER_H;

    // Through `displayUnits` like the value label above: a coordinate variable
    // can declare `unitless`/`1`/`n/a`, and "wavelength (1)" is noise on an axis.
    const axisUnits = displayUnits(first.profile.axis.units);
    const axisLabel = axisUnits
      ? `${first.profile.axis.name} (${axisUnits})`
      : first.profile.axis.name;

    body = (
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="h-full w-full"
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

        {niceTickValues(xMin, xMax, X_TICK_TARGET).map((position) => (
          <g key={position}>
            <line
              x1={scaleX(position)}
              y1={MARGIN.top + INNER_H}
              x2={scaleX(position)}
              y2={MARGIN.top + INNER_H + 4}
              stroke={AXIS}
            />
            <text
              x={scaleX(position)}
              y={MARGIN.top + INNER_H + 16}
              textAnchor="middle"
              fontSize={10}
              fill={TICK}
            >
              {formatValue(position)}
            </text>
          </g>
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
          {charted.map((sample) => {
            const xs = netcdfAxisPositions(sample);
            // Break the path at every fill reading, so a gap shows as a gap
            // rather than a line drawn through the nodata value.
            const segments: string[] = [];
            let current: string[] = [];
            sample.profile.values.forEach((value, i) => {
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
                key={sample.id}
                d={segments.join(" ")}
                fill="none"
                stroke={netcdfSeriesColor(sample)}
                strokeWidth={1.25}
              />
            );
          })}
        </g>
      </svg>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {valueLabel ? <p className="text-[10px] text-muted-foreground">{valueLabel}</p> : null}

      <div ref={chartRef} className={`min-h-0 ${hasChart ? chartClassName : ""}`}>
        {body}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-[11px]"
          disabled={!hasChart}
          onClick={downloadPng}
        >
          <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {t("netcdfProfile.exportPng")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-[11px]"
          disabled={!hasChart}
          onClick={downloadCsv}
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          {t("netcdfProfile.exportCsv")}
        </Button>
      </div>
      {/* `role="alert"` like the Time Slider chart's export error: the message
          arrives after the click that triggered it, so without a live region a
          screen-reader user gets no word that the export failed. */}
      {exportError ? (
        <p className="text-[10px] text-destructive" role="alert">
          {exportError}
        </p>
      ) : null}

      <ul className="space-y-0.5">
        {samples.map((sample) => (
          <li
            key={sample.id}
            className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
          >
            {/* Not aria-hidden: the color is decorative, but the digit inside
                is what ties this row to its marker on the map, and the marker
                itself is hidden from assistive tech. This list is where that
                number has to be readable. */}
            <span
              className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold text-white"
              style={{ backgroundColor: netcdfSeriesColor(sample) }}
            >
              {sample.order}
            </span>
            {sample.lng.toFixed(4)}, {sample.lat.toFixed(4)}
          </li>
        ))}
      </ul>
    </div>
  );
}
