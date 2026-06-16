import {
  type GeoLibreLayer,
  VECTOR_COLOR_RAMPS,
  getVectorColorRamp,
  parseHexColorList,
  useAppStore,
} from "@geolibre/core";
import {
  RASTER_MAX_CLASSES,
  RASTER_MIN_CLASSES,
  type RasterBandStats,
  type RasterClassificationMethod,
  type RasterSymbology,
  computeRasterBreaks,
  getRasterBandStats,
  savedRasterSymbology,
} from "@geolibre/plugins";
import { Input, Label, Select, Separator, Textarea } from "@geolibre/ui";
import { useEffect, useMemo, useRef, useState } from "react";

type RasterStateRecord = {
  mode: "single" | "rgb";
  bands: number[];
  colormap: string;
  rescale: [number, number][] | null;
  nodata: number | "auto" | "off";
  stretch: "linear" | "log" | "sqrt";
  gamma: number;
};

const CLASSIFICATION_METHODS: {
  value: RasterClassificationMethod;
  label: string;
}[] = [
  { value: "equal-interval", label: "Equal interval" },
  { value: "quantile", label: "Quantile" },
  { value: "manual", label: "Manual breaks" },
];

const DEFAULT_RAMP = "viridis";
const DEFAULT_CLASS_COUNT = 5;
/** Sentinel `<Select>` value that switches the ramp to a user-defined list. */
const CUSTOM_RAMP_VALUE = "__custom__";
/** A custom ramp needs at least this many colors to interpolate. */
const MIN_CUSTOM_COLORS = 2;
/**
 * Named ramps sorted by label for the dropdown. A copy is sorted (not the
 * source array) so `getVectorColorRamp`'s first-ramp fallback stays viridis.
 */
const SORTED_COLOR_RAMPS = [...VECTOR_COLOR_RAMPS].sort((a, b) =>
  a.label.localeCompare(b.label),
);

function readRasterState(layer: GeoLibreLayer): RasterStateRecord {
  const raw =
    layer.metadata.rasterState &&
    typeof layer.metadata.rasterState === "object" &&
    !Array.isArray(layer.metadata.rasterState)
      ? (layer.metadata.rasterState as Record<string, unknown>)
      : {};
  const bands = Array.isArray(raw.bands)
    ? (raw.bands.filter((b) => typeof b === "number") as number[])
    : [1];
  const rescale =
    Array.isArray(raw.rescale) &&
    raw.rescale.every(
      (range) => Array.isArray(range) && range.length === 2,
    )
      ? (raw.rescale as [number, number][])
      : null;
  return {
    mode: raw.mode === "rgb" ? "rgb" : "single",
    bands: bands.length > 0 ? bands : [1],
    colormap: typeof raw.colormap === "string" ? raw.colormap : DEFAULT_RAMP,
    rescale,
    nodata:
      raw.nodata === "off" || typeof raw.nodata === "number"
        ? (raw.nodata as number | "off")
        : "auto",
    stretch:
      raw.stretch === "log" || raw.stretch === "sqrt"
        ? raw.stretch
        : "linear",
    gamma: typeof raw.gamma === "number" && raw.gamma > 0 ? raw.gamma : 1,
  };
}

function readBandCount(layer: GeoLibreLayer): number | null {
  const value = layer.metadata.bandCount;
  return typeof value === "number" && value > 0 ? value : null;
}

function readBandNames(layer: GeoLibreLayer): Map<number, string> {
  const raw = layer.metadata.bandNames;
  const map = new Map<number, string>();
  if (Array.isArray(raw)) {
    for (const pair of raw) {
      if (
        Array.isArray(pair) &&
        typeof pair[0] === "number" &&
        typeof pair[1] === "string"
      ) {
        map.set(pair[0], pair[1]);
      }
    }
  }
  return map;
}

function rangeFromBreaks(breaks: number[]): [number, number][] {
  return [[breaks[0], breaks[breaks.length - 1]]];
}

/**
 * Single-band pseudocolor (with optional discrete classification) and RGB
 * band-combination controls for a maplibre-gl-raster COG layer. Edits the
 * layer's `metadata.rasterState` (pushed to the control by the store sync) and
 * GeoLibre-owned `metadata.rasterSymbology` (consumed by the classification
 * render injection).
 *
 * @param props.layer - The selected raster store layer.
 */
export function RasterSymbologySection({ layer }: { layer: GeoLibreLayer }) {
  const updateLayer = useAppStore((s) => s.updateLayer);
  const state = readRasterState(layer);
  const bandCount = readBandCount(layer);
  const bandNames = readBandNames(layer);
  const symbology = savedRasterSymbology(layer);
  const band = state.bands[0] ?? 1;

  const [stats, setStats] = useState<RasterBandStats | null>(null);
  const lastStatsRef = useRef<RasterBandStats | null>(null);

  // Fetch band statistics lazily once the user is classifying (equal-interval
  // and quantile both need a data range / histogram). Aborts implicitly via
  // the cache + the manager's per-layer AbortController. Stats are cleared
  // first so a band/method switch shows "Computing data range…" rather than
  // the previous band's values.
  useEffect(() => {
    setStats(null);
    let cancelled = false;
    if (!symbology?.classified || symbology.method === "manual") return;
    void getRasterBandStats(layer.id, band).then((result) => {
      if (!cancelled && result) setStats(result);
    });
    return () => {
      cancelled = true;
    };
  }, [layer.id, band, symbology?.classified, symbology?.method]);

  // Classification can be enabled before stats arrive (breaks fall back to the
  // [0, …, 1] default range), and switching bands while classified leaves the
  // previous band's edges in place. When fresh stats land, recompute the breaks
  // if they're the placeholder range or no longer cover the band's data, so the
  // classification follows the band without extra interaction. A range the user
  // narrowed by hand (same band, so stats is unchanged) never reaches here.
  useEffect(() => {
    if (!stats || stats === lastStatsRef.current) return;
    lastStatsRef.current = stats;
    if (!symbology?.classified || symbology.method === "manual") return;
    const isDefaultRange =
      symbology.breaks[0] === 0 && symbology.breaks.at(-1) === 1;
    const coversData =
      stats.min >= symbology.breaks[0] &&
      stats.max <= symbology.breaks[symbology.breaks.length - 1];
    if (isDefaultRange || !coversData) recomputeSymbology({ ...symbology });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats]);

  const bandOptions = useMemo(() => {
    if (!bandCount) return [];
    return Array.from({ length: bandCount }, (_, index) => {
      const value = index + 1;
      const name = bandNames.get(value);
      return { value, label: name ? `${value}: ${name}` : `Band ${value}` };
    });
  }, [bandCount, bandNames]);

  function commit(options: {
    statePatch?: Partial<RasterStateRecord>;
    symbology?: RasterSymbology | null;
  }): void {
    const metadata: Record<string, unknown> = { ...layer.metadata };
    if (options.statePatch) {
      metadata.rasterState = { ...state, ...options.statePatch };
    }
    if (options.symbology === null) {
      delete metadata.rasterSymbology;
    } else if (options.symbology) {
      metadata.rasterSymbology = options.symbology;
    }
    updateLayer(layer.id, { metadata });
  }

  function recomputeSymbology(
    next: Pick<
      RasterSymbology,
      "ramp" | "reversed" | "method" | "classCount" | "customColors"
    >,
    overrides: { range?: [number, number]; manualBreaks?: number[] } = {},
  ): void {
    // Reusing the prior histogram here is safe: a range override only happens
    // for equal-interval (the Min/Max inputs are disabled for quantile), and
    // equal-interval breaks use only min/max — never the histogram.
    const effectiveStats: RasterBandStats | null = overrides.range
      ? { min: overrides.range[0], max: overrides.range[1], histogram: stats?.histogram ?? [] }
      : stats;
    const breaks = computeRasterBreaks(
      next.method,
      effectiveStats,
      next.classCount,
      overrides.manualBreaks ?? symbology?.breaks,
    );
    const custom =
      (next.customColors?.length ?? 0) >= MIN_CUSTOM_COLORS
        ? next.customColors
        : undefined;
    commit({
      statePatch: { colormap: next.ramp, rescale: rangeFromBreaks(breaks) },
      symbology: {
        classified: true,
        ramp: next.ramp,
        reversed: next.reversed,
        method: next.method,
        classCount: next.classCount,
        breaks,
        ...(custom ? { customColors: custom } : {}),
      },
    });
  }

  // --- Mode ---
  const modeControl = (
    <div className="space-y-2">
      <Label htmlFor="rasterMode">Render mode</Label>
      <Select
        id="rasterMode"
        value={state.mode}
        disabled={bandCount === null}
        onChange={(event) => {
          const mode = event.target.value as "single" | "rgb";
          if (mode === "rgb") {
            const bands =
              state.bands.length >= 3 ? state.bands.slice(0, 3) : [1, 2, 3];
            commit({ statePatch: { mode, bands }, symbology: null });
          } else {
            commit({ statePatch: { mode } });
          }
        }}
      >
        <option value="single">Single band (pseudocolor)</option>
        {(bandCount === null || bandCount >= 3) && (
          <option value="rgb">RGB composite</option>
        )}
      </Select>
      {bandCount === null && (
        <p className="text-[10px] text-muted-foreground">Loading bands…</p>
      )}
    </div>
  );

  if (state.mode === "rgb") {
    return (
      <div className="space-y-3">
        <Separator />
        <p className="text-xs font-semibold">Raster symbology</p>
        {modeControl}
        <RgbControls
          state={state}
          bandOptions={bandOptions}
          onChange={(patch) => commit({ statePatch: patch })}
        />
        <NodataControl state={state} onChange={(nodata) => commit({ statePatch: { nodata } })} />
      </div>
    );
  }

  const ramp = symbology?.ramp ?? state.colormap ?? DEFAULT_RAMP;
  const classified = symbology?.classified ?? false;
  const classCount = symbology?.classCount ?? DEFAULT_CLASS_COUNT;
  const method = symbology?.method ?? "equal-interval";
  const reversed = symbology?.reversed ?? false;
  const customColors = symbology?.customColors;
  const isCustom = (customColors?.length ?? 0) >= MIN_CUSTOM_COLORS;
  // A custom ramp interpolates the user's colors; otherwise the named ramp's
  // anchors. The preview mirrors the reverse toggle either way.
  const baseColors = isCustom
    ? (customColors as string[])
    : getVectorColorRamp(ramp).colors;
  const orderedPreview = reversed ? [...baseColors].reverse() : baseColors;
  const rampSelectValue = isCustom ? CUSTOM_RAMP_VALUE : ramp;

  // Reverse and custom colors are GeoLibre extensions the upstream control
  // can't express; a continuous (unclassified) layer carries them in a
  // classified:false record the render injection reads, or none at all when
  // both are off (the plain upstream colormap renders on its own). Breaks are
  // required by the record but unused while continuous, so seed them from
  // whatever range is known.
  function continuousSymbology(opts: {
    ramp: string;
    reversed: boolean;
    customColors?: string[];
  }): RasterSymbology | null {
    const custom =
      (opts.customColors?.length ?? 0) >= MIN_CUSTOM_COLORS
        ? opts.customColors
        : undefined;
    if (!opts.reversed && !custom) return null;
    return {
      classified: false,
      ramp: opts.ramp,
      reversed: opts.reversed,
      method,
      classCount,
      breaks: computeRasterBreaks(method, stats, classCount),
      ...(custom ? { customColors: custom } : {}),
    };
  }

  // Reverse applies to both render paths. Classified bakes the flip into the
  // injected texture, so toggling only rewrites the symbology (breaks unchanged).
  function setReversed(next: boolean): void {
    if (classified && symbology) {
      commit({ symbology: { ...symbology, reversed: next } });
    } else {
      commit({
        symbology: continuousSymbology({ ramp, reversed: next, customColors }),
      });
    }
  }

  // Switch to / edit / clear a user-defined ramp. `next` is the parsed color
  // list (>= 2 colors) or undefined to drop back to the named ramp.
  function setCustomColors(next: string[] | undefined): void {
    if (classified && symbology) {
      recomputeSymbology({
        ramp,
        reversed,
        method,
        classCount,
        customColors: next,
      });
    } else {
      commit({
        symbology: continuousSymbology({ ramp, reversed, customColors: next }),
      });
    }
  }

  // Select a built-in named ramp (clears any custom colors). Classified
  // recomputes through the named ramp; continuous pushes the colormap to the
  // control and keeps only the reverse extra (if any).
  function selectNamedRamp(value: string): void {
    if (classified && symbology) {
      recomputeSymbology({
        ramp: value,
        reversed,
        method,
        classCount,
        customColors: undefined,
      });
    } else {
      commit({
        statePatch: { colormap: value },
        symbology: continuousSymbology({
          ramp: value,
          reversed,
          customColors: undefined,
        }),
      });
    }
  }

  return (
    <div className="space-y-3">
      <Separator />
      <p className="text-xs font-semibold">Raster symbology</p>
      {modeControl}

      <div className="space-y-2">
        <Label htmlFor="rasterBand">Band</Label>
        <Select
          id="rasterBand"
          value={String(band)}
          disabled={bandOptions.length === 0}
          onChange={(event) =>
            commit({ statePatch: { bands: [Number(event.target.value)] } })
          }
        >
          {bandOptions.length === 0 ? (
            <option value={String(band)}>{`Band ${band}`}</option>
          ) : (
            bandOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))
          )}
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="rasterRamp">Color ramp</Label>
        <Select
          id="rasterRamp"
          value={rampSelectValue}
          onChange={(event) => {
            const value = event.target.value;
            if (value === CUSTOM_RAMP_VALUE) {
              // Seed the editable list from the current named ramp's anchors so
              // the user starts from a sensible, valid (>= 2 color) ramp.
              setCustomColors([...getVectorColorRamp(ramp).colors]);
            } else {
              selectNamedRamp(value);
            }
          }}
        >
          {/* A raster may arrive with any upstream colormap name (e.g. the
              control's "gray"/"palette" default); surface it so the select
              reflects what is actually rendered instead of silently showing
              the first ramp. */}
          {!isCustom && !VECTOR_COLOR_RAMPS.some((r) => r.value === ramp) && (
            <option value={ramp}>{ramp}</option>
          )}
          {SORTED_COLOR_RAMPS.map((colorRamp) => (
            <option key={colorRamp.value} value={colorRamp.value}>
              {colorRamp.label}
            </option>
          ))}
          <option value={CUSTOM_RAMP_VALUE}>Custom…</option>
        </Select>
        <div
          aria-hidden="true"
          className="h-4 rounded-sm border"
          style={{
            background: `linear-gradient(90deg, ${orderedPreview.join(", ")})`,
          }}
        />
        {isCustom && (
          <CustomColorsField
            colors={customColors as string[]}
            onCommit={(colors) => setCustomColors(colors)}
          />
        )}
      </div>

      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={reversed}
          onChange={(event) => setReversed(event.target.checked)}
        />
        Reverse ramp
      </label>

      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={classified}
          onChange={(event) => {
            if (event.target.checked) {
              recomputeSymbology({
                ramp,
                reversed,
                method,
                classCount,
                customColors,
              });
            } else {
              // Drop classification but keep any reversed / custom ramp extras.
              commit({
                symbology: continuousSymbology({ ramp, reversed, customColors }),
              });
            }
          }}
        />
        Classify into discrete classes
      </label>

      {classified && symbology && (
        <ClassificationControls
          symbology={symbology}
          stats={stats}
          onMethod={(nextMethod) =>
            recomputeSymbology({ ...symbology, method: nextMethod })
          }
          onClassCount={(count) =>
            recomputeSymbology({ ...symbology, classCount: count })
          }
          onManualBreaks={(breaks) => {
            // Keep edges ascending: savedRasterSymbology rejects unsorted
            // breaks, which would silently collapse the classification UI.
            const sorted = [...breaks].sort((a, b) => a - b);
            commit({
              statePatch: { rescale: rangeFromBreaks(sorted) },
              symbology: { ...symbology, breaks: sorted },
            });
          }}
          onRange={(range) => recomputeSymbology({ ...symbology }, { range })}
        />
      )}

      {!classified && (
        <RescaleControls
          rescale={state.rescale}
          onChange={(rescale) => commit({ statePatch: { rescale } })}
        />
      )}

      {!classified && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="rasterStretch">Stretch</Label>
            <Select
              id="rasterStretch"
              value={state.stretch}
              onChange={(event) =>
                commit({
                  statePatch: {
                    stretch: event.target.value as "linear" | "log" | "sqrt",
                  },
                })
              }
            >
              <option value="linear">Linear</option>
              <option value="log">Logarithmic</option>
              <option value="sqrt">Square root</option>
            </Select>
          </div>
          <NumberField
            label="Gamma"
            value={state.gamma}
            step={0.1}
            min={0.1}
            onCommit={(value) =>
              commit({ statePatch: { gamma: value > 0 ? value : 1 } })
            }
          />
        </div>
      )}

      <NodataControl
        state={state}
        onChange={(nodata) => commit({ statePatch: { nodata } })}
      />
    </div>
  );
}

function RgbControls({
  state,
  bandOptions,
  onChange,
}: {
  state: RasterStateRecord;
  bandOptions: { value: number; label: string }[];
  onChange: (patch: Partial<RasterStateRecord>) => void;
}) {
  const bands = state.bands.length >= 3 ? state.bands : [1, 2, 3];
  const channels: { key: "R" | "G" | "B"; index: number }[] = [
    { key: "R", index: 0 },
    { key: "G", index: 1 },
    { key: "B", index: 2 },
  ];
  return (
    <div className="space-y-2">
      {channels.map(({ key, index }) => (
        <div key={key} className="grid grid-cols-[1.5rem_1fr] items-center gap-2">
          <Label className="text-xs">{key}</Label>
          <Select
            value={String(bands[index] ?? index + 1)}
            disabled={bandOptions.length === 0}
            onChange={(event) => {
              const next = [...bands];
              next[index] = Number(event.target.value);
              onChange({ bands: next });
            }}
          >
            {bandOptions.length === 0 ? (
              <option value={String(bands[index] ?? index + 1)}>
                {`Band ${bands[index] ?? index + 1}`}
              </option>
            ) : (
              bandOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))
            )}
          </Select>
        </div>
      ))}
    </div>
  );
}

function ClassificationControls({
  symbology,
  stats,
  onMethod,
  onClassCount,
  onManualBreaks,
  onRange,
}: {
  symbology: RasterSymbology;
  stats: RasterBandStats | null;
  onMethod: (method: RasterClassificationMethod) => void;
  onClassCount: (count: number) => void;
  onManualBreaks: (breaks: number[]) => void;
  onRange: (range: [number, number]) => void;
}) {
  const min = symbology.breaks[0];
  const max = symbology.breaks[symbology.breaks.length - 1];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="rasterMethod">Method</Label>
          <Select
            id="rasterMethod"
            value={symbology.method}
            onChange={(event) =>
              onMethod(event.target.value as RasterClassificationMethod)
            }
          >
            {CLASSIFICATION_METHODS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="rasterClasses">Classes</Label>
          <Select
            id="rasterClasses"
            value={String(symbology.classCount)}
            onChange={(event) => onClassCount(Number(event.target.value))}
          >
            {Array.from(
              { length: RASTER_MAX_CLASSES - RASTER_MIN_CLASSES + 1 },
              (_, index) => RASTER_MIN_CLASSES + index,
            ).map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {symbology.method !== "manual" && (
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Min"
            value={min}
            step={Number.isFinite(max - min) ? (max - min) / 100 || 0.1 : 0.1}
            disabled={symbology.method === "quantile"}
            onCommit={(value) => onRange([value, max])}
          />
          <NumberField
            label="Max"
            value={max}
            step={Number.isFinite(max - min) ? (max - min) / 100 || 0.1 : 0.1}
            disabled={symbology.method === "quantile"}
            onCommit={(value) => onRange([min, value])}
          />
        </div>
      )}

      {symbology.method === "manual" && (
        <div className="space-y-2">
          <Label className="text-xs">Class edges</Label>
          {symbology.breaks.map((edge, index) => (
            <NumberField
              key={index}
              label={`Edge ${index + 1}`}
              value={edge}
              step={0.1}
              onCommit={(value) => {
                const next = [...symbology.breaks];
                next[index] = value;
                onManualBreaks(next);
              }}
            />
          ))}
        </div>
      )}

      {symbology.method !== "manual" && !stats && (
        <p className="text-[10px] text-muted-foreground">
          Computing data range…
        </p>
      )}
    </div>
  );
}

function RescaleControls({
  rescale,
  onChange,
}: {
  rescale: [number, number][] | null;
  onChange: (rescale: [number, number][] | null) => void;
}) {
  const range = rescale?.[0];
  // The rescale data model is all-or-nothing ([min, max] or null = auto), so
  // clearing either bound drops back to auto-stretch on both — a single bound
  // can't be pinned independently.
  return (
    <div className="grid grid-cols-2 gap-3">
      <NumberField
        label="Min"
        value={range?.[0] ?? ""}
        placeholder="auto"
        step={0.1}
        onCommit={(value, empty) => {
          if (empty) return onChange(null);
          onChange([[value, range?.[1] ?? value]]);
        }}
      />
      <NumberField
        label="Max"
        value={range?.[1] ?? ""}
        placeholder="auto"
        step={0.1}
        onCommit={(value, empty) => {
          if (empty) return onChange(null);
          onChange([[range?.[0] ?? value, value]]);
        }}
      />
    </div>
  );
}

function NodataControl({
  state,
  onChange,
}: {
  state: RasterStateRecord;
  onChange: (nodata: number | "auto" | "off") => void;
}) {
  const mode =
    state.nodata === "off"
      ? "off"
      : typeof state.nodata === "number"
        ? "custom"
        : "auto";
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-2">
        <Label htmlFor="rasterNodata">No data</Label>
        <Select
          id="rasterNodata"
          value={mode}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "off") onChange("off");
            else if (value === "custom") onChange(0);
            else onChange("auto");
          }}
        >
          <option value="auto">Auto (from file)</option>
          <option value="off">Render all pixels</option>
          <option value="custom">Custom value</option>
        </Select>
      </div>
      {mode === "custom" && (
        <NumberField
          label="Value"
          value={typeof state.nodata === "number" ? state.nodata : 0}
          step={1}
          onCommit={(value) => onChange(value)}
        />
      )}
    </div>
  );
}

/**
 * Free-text editor for a user-defined color ramp: a list of hex codes parsed
 * into the ramp's anchor colors. Edits are committed on blur, and only when
 * they yield a usable ramp (>= 2 valid colors) so the layer never lands in an
 * invalid state; an unusable draft is reverted to the last good list.
 *
 * @param props.colors - The current custom colors.
 * @param props.onCommit - Receives the parsed colors when the draft is valid.
 */
function CustomColorsField({
  colors,
  onCommit,
}: {
  colors: string[];
  onCommit: (colors: string[]) => void;
}) {
  const [draft, setDraft] = useState(colors.join(", "));
  useEffect(() => {
    setDraft(colors.join(", "));
  }, [colors]);
  const parsed = parseHexColorList(draft);
  const valid = parsed.length >= MIN_CUSTOM_COLORS;
  return (
    <div className="space-y-1">
      <Label htmlFor="rasterCustomColors" className="text-xs">
        Custom colors
      </Label>
      <Textarea
        id="rasterCustomColors"
        rows={2}
        value={draft}
        placeholder="#440154, #21908c, #fde725"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (valid) onCommit(parsed);
          else setDraft(colors.join(", "));
        }}
      />
      <p className="text-[10px] text-muted-foreground">
        {valid
          ? `${parsed.length} colors, low to high. Use Reverse to flip.`
          : "Enter at least two hex codes, separated by commas or spaces."}
      </p>
    </div>
  );
}

function NumberField({
  label,
  value,
  step,
  min,
  disabled,
  placeholder,
  onCommit,
}: {
  label: string;
  value: number | "";
  step: number;
  min?: number;
  disabled?: boolean;
  placeholder?: string;
  onCommit: (value: number, empty: boolean) => void;
}) {
  // Local draft so the user can clear / retype freely; committed on blur (one
  // store write / setRasterState per edit, instead of one per keystroke).
  const [draft, setDraft] = useState<string>(value === "" ? "" : String(value));
  useEffect(() => {
    setDraft(value === "" ? "" : String(value));
  }, [value]);
  const commitDraft = () => {
    if (draft.trim() === "") {
      onCommit(0, true);
      return;
    }
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) onCommit(parsed, false);
  };
  return (
    <div className="space-y-2">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        disabled={disabled}
        placeholder={placeholder}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </div>
  );
}
