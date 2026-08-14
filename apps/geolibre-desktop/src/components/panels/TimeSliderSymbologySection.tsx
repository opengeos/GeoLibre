import type { GeoLibreLayer } from "@geolibre/core";
import {
  colormapColors,
  getTimeSliderSymbology,
  parseBandList,
  setTimeSliderSymbology,
  type TimeSliderSymbology,
  warmColormapColors,
} from "@geolibre/plugins";
import {
  type ColorRampOption,
  ColorRampSelect,
  Input,
  Label,
  Select,
  Separator,
} from "@geolibre/ui";
import { COLORMAP_OPTIONS } from "maplibre-gl-raster";
import { boundText, nextRescaleWindow } from "../../lib/rescale-window";
import { useEffect, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Symbology controls for a raster source added through the Time Slider dock.
 *
 * The Style panel's usual Raster symbology section is driven by the raster
 * plugin's own layer registry (band statistics, classification, saved
 * symbology), and a dock source is not in it — which is why a Time Slider COG
 * or mosaic layer showed no symbology at all. What a dock source does expose is
 * the four fields its spec carries, applied live by the control, so this is a
 * thin form over those: color ramp, band selection, rescale window, and nodata.
 *
 * COG and mosaic sources take the same four fields and are both editable here.
 * Which adapter renders them is the library's business, not the panel's — and
 * the distinction is not even visible from the spec, since a COG on the
 * `gpu`/`wasm` engine reports itself as a mosaic.
 */

/** Sentinel `<Select>`/ramp value for "no colormap" (RGB / multi-band). */
const NO_COLORMAP = "__none__";

/** Every renderer colormap, sorted by label, matching the raster panel's list.
 * A fixed "en" locale keeps the order identical across browsers. */
const SORTED_COLORMAPS = [...COLORMAP_OPTIONS].sort((a, b) =>
  a.label.localeCompare(b.label, "en", { sensitivity: "base" }),
);

export function TimeSliderSymbologySection({ layer }: { layer: GeoLibreLayer }) {
  const { t } = useTranslation();
  // Read live on every render rather than captured into state. The spec lives on
  // the dock's control, not the store, and that control is created a tick after
  // the plugin activates — a value seeded at mount would be null for the whole
  // session, since the panel can mount before the Time Slider finishes
  // restoring and nothing would ever re-read it.
  const symbology = getTimeSliderSymbology(layer.id);
  // Forces the re-read above after a commit, so the form shows what the spec now
  // holds instead of the values it was rendered with.
  const [, refresh] = useReducer((n: number) => n + 1, 0);

  // The band list is a free-text field, so it keeps a draft the user can type
  // into; it re-syncs whenever the underlying selection changes (including when
  // the control arrives late), but never mid-edit, since the draft alone changes
  // while typing.
  const bandsValue = symbology?.bands.join(",") ?? "";
  const [bandsDraft, setBandsDraft] = useState(bandsValue);
  const [bandsInvalid, setBandsInvalid] = useState(false);
  useEffect(() => {
    setBandsDraft(bandsValue);
    setBandsInvalid(false);
  }, [bandsValue]);

  // The rescale window is a *pair*: the renderer takes a full [min, max] or
  // auto-stretches. Both bounds are therefore drafted here so a half-entered
  // window can be held without being applied — inferring the missing end from
  // the typed one meant entering a max of 255 also set the min to 255.
  const specMin = symbology?.rescale?.[0] ?? null;
  const specMax = symbology?.rescale?.[1] ?? null;
  const [minDraft, setMinDraft] = useState(() => boundText(specMin));
  const [maxDraft, setMaxDraft] = useState(() => boundText(specMax));
  useEffect(() => {
    // Follow the spec only while it holds a complete window. Not when it
    // clears: clearing is what this form does when a bound is emptied, and
    // re-syncing then would wipe the bound the user still has typed.
    if (specMin == null || specMax == null) return;
    setMinDraft(boundText(specMin));
    setMaxDraft(boundText(specMax));
  }, [specMin, specMax]);
  useEffect(() => {
    // A different layer's window is unrelated to whatever was drafted for the
    // previous one, so switching layers resets both ends.
    setMinDraft(boundText(specMin));
    setMaxDraft(boundText(specMax));
    // Only the layer identity should reset the drafts; the spec values are
    // handled by the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.id]);

  // Colors for every colormap so each option in the picker shows its own
  // swatch. Built-ins resolve synchronously; the rest are sampled from the
  // renderer's sprite once and fill in as they land.
  const [rampColors, setRampColors] = useState<Record<string, readonly string[]>>(() => {
    const seed: Record<string, readonly string[]> = {};
    for (const colormap of SORTED_COLORMAPS) {
      const known = colormapColors(colormap.name);
      if (known) seed[colormap.name] = known;
    }
    return seed;
  });
  useEffect(() => {
    let cancelled = false;
    for (const colormap of SORTED_COLORMAPS) {
      if (colormapColors(colormap.name)) continue;
      void warmColormapColors(colormap.name).then((colors) => {
        if (cancelled || !colors) return;
        setRampColors((prev) =>
          prev[colormap.name] ? prev : { ...prev, [colormap.name]: colors },
        );
      });
    }
    return () => {
      // Guards state only: in-flight warms keep filling the module-level cache,
      // so a remount picks them up synchronously from the seed above.
      cancelled = true;
    };
  }, []);

  // The dock was closed, or this layer is an XYZ/WMS/GeoJSON source with no
  // symbology to edit.
  if (!symbology) return null;

  /** Applies a change to the source, then re-reads the spec so the form shows
   * what the renderer was actually given. */
  const commit = (patch: Partial<TimeSliderSymbology>) => {
    if (setTimeSliderSymbology(layer.id, patch)) refresh();
  };

  const rampOptions: ColorRampOption[] = [
    { value: NO_COLORMAP, label: t("timeSliderSymbology.colormapNone"), colors: [] },
    ...SORTED_COLORMAPS.map((colormap) => ({
      value: colormap.name,
      label: colormap.label,
      colors: rampColors[colormap.name] ?? [],
    })),
  ];

  /**
   * Applies the drafted window, or drops back to auto-stretch while it is
   * incomplete. Never fills in the end the user has not typed: a one-sided
   * window is not something the renderer can express, so the layer keeps
   * auto-stretching until both bounds are present.
   */
  const commitRescale = (nextMin: string, nextMax: string) => {
    setMinDraft(nextMin);
    setMaxDraft(nextMax);
    const window = nextRescaleWindow(nextMin, nextMax);
    if (!window) {
      // Only write when a window was actually applied, so typing the first of
      // the two bounds is not a pointless re-render of the raster.
      if (specMin != null || specMax != null) commit({ rescale: null });
      return;
    }
    commit({ rescale: window });
  };

  const nodataMode =
    symbology.nodata === "off" ? "off" : typeof symbology.nodata === "number" ? "custom" : "auto";

  return (
    <div className="space-y-3">
      <Separator />
      <h3 className="text-sm font-medium">{t("rasterSymbology.heading")}</h3>

      <div className="space-y-2">
        <Label htmlFor="tsRamp">{t("rasterSymbology.colorRampLabel")}</Label>
        <ColorRampSelect
          id="tsRamp"
          aria-label={t("rasterSymbology.colorRampLabel")}
          value={symbology.colormap ?? NO_COLORMAP}
          ramps={rampOptions}
          onValueChange={(value) => commit({ colormap: value === NO_COLORMAP ? null : value })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="tsBands">{t("timeSliderSymbology.bands")}</Label>
        <Input
          id="tsBands"
          value={bandsDraft}
          placeholder={t("timeSliderSymbology.bandsPlaceholder")}
          aria-invalid={bandsInvalid || undefined}
          onChange={(event) => setBandsDraft(event.target.value)}
          // Committed on blur, not per keystroke: a half-typed "4," would
          // otherwise re-render the mosaic against a band set the user has not
          // finished choosing.
          onBlur={() => {
            const bands = parseBandList(bandsDraft);
            if (!bands) {
              setBandsInvalid(true);
              return;
            }
            setBandsInvalid(false);
            commit({ bands });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <p className={`text-xs ${bandsInvalid ? "text-destructive" : "text-muted-foreground"}`}>
          {bandsInvalid
            ? t("timeSliderSymbology.bandsInvalid")
            : t("timeSliderSymbology.bandsHint")}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <BoundField
          id="tsRescaleMin"
          label={t("rasterSymbology.min")}
          draft={minDraft}
          placeholder={t("rasterSymbology.autoPlaceholder")}
          onDraftChange={setMinDraft}
          onCommit={(value) => commitRescale(value, maxDraft)}
        />
        <BoundField
          id="tsRescaleMax"
          label={t("rasterSymbology.max")}
          draft={maxDraft}
          placeholder={t("rasterSymbology.autoPlaceholder")}
          onDraftChange={setMaxDraft}
          onCommit={(value) => commitRescale(minDraft, value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="tsNodata">{t("rasterSymbology.noData")}</Label>
          <Select
            id="tsNodata"
            value={nodataMode}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "off") commit({ nodata: "off" });
              else if (value === "custom") commit({ nodata: 0 });
              else commit({ nodata: null });
            }}
          >
            <option value="auto">{t("rasterSymbology.nodataAuto")}</option>
            {/* "Render all pixels" is the client renderer's own spelling; a
                TiTiler-engine COG takes a number (or 'nan') and would reject it. */}
            {symbology.type === "mosaic" ? (
              <option value="off">{t("rasterSymbology.nodataOff")}</option>
            ) : null}
            <option value="custom">{t("rasterSymbology.nodataCustom")}</option>
          </Select>
        </div>
        {nodataMode === "custom" ? (
          <NumberField
            id="tsNodataValue"
            label={t("rasterSymbology.value")}
            value={typeof symbology.nodata === "number" ? symbology.nodata : 0}
            step={1}
            onCommit={(value) => {
              const parsed = Number(value);
              if (Number.isFinite(parsed)) commit({ nodata: parsed });
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * A labeled number input that commits on blur rather than on every keystroke.
 *
 * Each commit re-renders the raster, so committing per keystroke would push a
 * new window for every digit of "15" — and clearing the field to retype would
 * momentarily send "auto". The draft absorbs that.
 *
 * @param props.value - The committed value, or "" when the field is unset.
 * @param props.onCommit - Receives the raw field text (empty means "unset").
 */
function NumberField({
  id,
  label,
  value,
  step,
  placeholder,
  onCommit,
}: {
  id: string;
  label: string;
  value: number | "";
  step: number;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value === "" ? "" : String(value));
  useEffect(() => {
    setDraft(value === "" ? "" : String(value));
  }, [value]);
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step={step}
        placeholder={placeholder}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => onCommit(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </div>
  );
}

/**
 * One end of the rescale window. Unlike {@link NumberField} the draft lives in
 * the parent, because the two bounds are only meaningful as a pair: committing
 * one has to see what the other currently holds.
 *
 * @param props.draft - The current field text, owned by the parent.
 * @param props.onCommit - Receives the field text on blur or Enter.
 */
function BoundField({
  id,
  label,
  draft,
  placeholder,
  onDraftChange,
  onCommit,
}: {
  id: string;
  label: string;
  draft: string;
  placeholder?: string;
  onDraftChange: (value: string) => void;
  onCommit: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step={0.1}
        placeholder={placeholder}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onBlur={(event) => onCommit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </div>
  );
}
