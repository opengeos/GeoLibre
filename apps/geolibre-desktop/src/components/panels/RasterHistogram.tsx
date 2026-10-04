/**
 * Interactive histogram for a raster band's display stretch: the band's bins
 * drawn as a compact inline SVG with the active window shaded and two
 * draggable, keyboard-operable cut-point handles. Drawn inline rather than
 * through `charts/ChartView`, which renders fixed-size, non-interactive charts
 * with axes and captions; this one has to fit the Style panel's width and map
 * pointer positions back to values.
 */
import { getRasterBandStats, type RasterBandStats } from "@geolibre/plugins";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  type HistogramStats,
  type StretchHandle,
  type ValueRange,
  histogramBars,
  histogramDomain,
  moveHandle,
  nearestHandle,
  nudgeStep,
  pixelToValue,
  roundForDomain,
  valueToPixel,
} from "../../lib/raster-histogram";

/** Delay before a drag or key nudge is written to the layer. */
export const HISTOGRAM_COMMIT_DELAY_MS = 150;

const CHART_W = 240;
const CHART_H = 48;

/**
 * Renders a band's histogram with draggable stretch handles.
 *
 * @param props.stats - The band statistics, or null while they load.
 * @param props.range - The window the layer renders with today.
 * @param props.isAuto - True when `range` is the renderer's auto stretch.
 * @param props.bandLabel - Names the band in the handles' accessible labels.
 * @param props.onCommit - Receives the new window (debounced while dragging).
 * @param props.loading - True while statistics are being computed.
 */
export function RasterHistogram({
  stats,
  range,
  isAuto,
  bandLabel,
  onCommit,
  loading,
}: {
  stats: HistogramStats | null;
  range: ValueRange | null;
  isAuto: boolean;
  bandLabel: string;
  onCommit: (range: ValueRange) => void;
  loading?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<ValueRange | null>(range);
  const [dragging, setDragging] = useState<StretchHandle | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<ValueRange | null>(null);
  // The parent rebuilds onCommit every render; reading it from a ref keeps the
  // debounced flush writing through the latest layer snapshot.
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  // Follow edits made elsewhere (the Min/Max inputs, viewport stretch) unless
  // the user is mid-drag or has a nudge waiting to flush.
  const rangeKey = range ? `${range[0]},${range[1]}` : "";
  useEffect(() => {
    if (dragging || pendingRef.current) return;
    setDraft(range);
    // rangeKey captures range's identity by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey, dragging]);

  // Reads only refs, so it is stable and safe to call from the unmount cleanup.
  const flush = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) onCommitRef.current(pending);
  }, []);

  // Write any pending edit when the histogram goes away (band switch, panel
  // close) rather than dropping the last drag.
  useEffect(() => () => flush(), [flush]);

  const schedule = (next: ValueRange) => {
    pendingRef.current = next;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, HISTOGRAM_COMMIT_DELAY_MS);
  };

  if (!stats) {
    return (
      <p className="text-[10px] text-muted-foreground">
        {loading
          ? t("rasterSymbology.histogramLoading")
          : t("rasterSymbology.histogramUnavailable")}
      </p>
    );
  }

  const domain = histogramDomain(stats, draft);
  const active = draft;
  if (!domain || !active) {
    return (
      <p className="text-[10px] text-muted-foreground">
        {t("rasterSymbology.histogramUnavailable")}
      </p>
    );
  }

  const bars = histogramBars(stats, domain, CHART_W, CHART_H);
  const lowX = valueToPixel(active[0], domain, CHART_W);
  const highX = valueToPixel(active[1], domain, CHART_W);
  const format = new Intl.NumberFormat(i18n.language, { maximumSignificantDigits: 6 });

  const update = (handle: StretchHandle, value: number) => {
    // The auto window is an interpolated percentile; round the handle that
    // isn't moving too, so the first edit doesn't pin float noise into the
    // Min/Max inputs. A saved window keeps the user's exact value.
    const base: ValueRange = isAuto
      ? [roundForDomain(active[0], domain), roundForDomain(active[1], domain)]
      : active;
    const next = moveHandle(base, handle, roundForDomain(value, domain), domain);
    setDraft(next);
    schedule(next);
  };

  const valueAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return active[0];
    return pixelToValue(clientX - rect.left, domain, rect.width);
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>, handle?: StretchHandle) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const value = valueAt(event.clientX);
    const grabbed = handle ?? nearestHandle(active, value);
    setDragging(grabbed);
    trackRef.current?.setPointerCapture?.(event.pointerId);
    // A press on the bare track jumps the nearer handle there; a press on a
    // handle just grabs it, so a click doesn't nudge it off by a pixel.
    if (!handle) update(grabbed, value);
    trackRef.current
      ?.querySelector<HTMLElement>(`[data-handle="${grabbed}"]`)
      ?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, handle: StretchHandle) => {
    const step = nudgeStep(domain) * (event.shiftKey ? 10 : 1);
    const current = handle === "min" ? active[0] : active[1];
    let next: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = current - step;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = current + step;
        break;
      case "PageDown":
        next = current - step * 10;
        break;
      case "PageUp":
        next = current + step * 10;
        break;
      case "Home":
        next = domain[0];
        break;
      case "End":
        next = domain[1];
        break;
      default:
        return;
    }
    event.preventDefault();
    update(handle, next);
  };

  const handles: { id: StretchHandle; x: number; value: number; label: string }[] = [
    {
      id: "min",
      x: lowX,
      value: active[0],
      label: t("rasterSymbology.histogramMinAria", { band: bandLabel }),
    },
    {
      id: "max",
      x: highX,
      value: active[1],
      label: t("rasterSymbology.histogramMaxAria", { band: bandLabel }),
    },
  ];

  return (
    // A value axis reads low-to-high left-to-right in every locale, so the
    // chart (and its pixel math) stays ltr inside a mirrored panel.
    <div className="space-y-1" dir="ltr">
      <div
        ref={trackRef}
        className="relative h-12 touch-none select-none rounded-sm border bg-muted/30"
        onPointerDown={(event) => startDrag(event)}
        onPointerMove={(event) => {
          if (dragging) update(dragging, valueAt(event.clientX));
        }}
        onPointerUp={(event) => {
          if (!dragging) return;
          trackRef.current?.releasePointerCapture?.(event.pointerId);
          setDragging(null);
          flush();
        }}
        onPointerCancel={() => {
          setDragging(null);
          flush();
        }}
      >
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <rect
            x={lowX}
            y={0}
            width={Math.max(highX - lowX, 0)}
            height={CHART_H}
            fill="hsl(var(--primary))"
            fillOpacity={isAuto ? 0.08 : 0.15}
          />
          {bars.map((bar, index) => (
            <rect
              key={index}
              x={bar.x}
              y={CHART_H - bar.height}
              width={bar.width}
              height={bar.height}
              fill="hsl(var(--muted-foreground))"
              fillOpacity={0.55}
            />
          ))}
        </svg>
        {handles.map((handle) => (
          <div
            key={handle.id}
            data-handle={handle.id}
            role="slider"
            tabIndex={0}
            aria-label={handle.label}
            aria-orientation="horizontal"
            aria-valuemin={handle.id === "min" ? domain[0] : active[0]}
            aria-valuemax={handle.id === "min" ? active[1] : domain[1]}
            aria-valuenow={handle.value}
            aria-valuetext={format.format(handle.value)}
            className="absolute inset-y-0 -ms-1.5 flex w-3 cursor-ew-resize justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ left: `${(handle.x / CHART_W) * 100}%` }}
            onPointerDown={(event) => startDrag(event, handle.id)}
            onKeyDown={(event) => onKeyDown(event, handle.id)}
            onBlur={flush}
          >
            <span
              className="h-full w-0.5"
              style={{
                background: "hsl(var(--primary))",
                opacity: isAuto ? 0.6 : 1,
              }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>{format.format(active[0])}</span>
        <span>{isAuto ? t("rasterSymbology.autoPlaceholder") : null}</span>
        <span>{format.format(active[1])}</span>
      </div>
    </div>
  );
}

/**
 * Loads histogram statistics for each listed band of a raster layer. The
 * reads run one after another: `getRasterBandStats` keeps one in-flight read
 * per layer and aborts the previous one, and the first read caches every
 * band, so the rest resolve from the cache.
 *
 * @param layerId - The raster layer.
 * @param bands - The 1-based bands to summarize.
 * @param fallbackUrl - The session blob for a file-backed raster.
 * @param enabled - False skips loading (e.g. while classified).
 * @returns Per-band statistics and whether a read is still running.
 */
export function useRasterHistogramStats(
  layerId: string,
  bands: readonly number[],
  fallbackUrl: string | null,
  enabled: boolean,
): { stats: Map<number, RasterBandStats>; loading: boolean } {
  const [stats, setStats] = useState<Map<number, RasterBandStats>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const bandsKey = bands.join(",");
  useEffect(() => {
    setStats(new Map());
    if (!enabled || bandsKey === "") {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const next = new Map<number, RasterBandStats>();
      for (const band of new Set(bandsKey.split(",").map(Number))) {
        const result = await getRasterBandStats(layerId, band, fallbackUrl);
        if (cancelled) return;
        if (result) next.set(band, result);
      }
      setStats(next);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [layerId, bandsKey, fallbackUrl, enabled]);
  return { stats, loading };
}
