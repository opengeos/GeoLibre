import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
} from "@geolibre/ui";
import type { MapController } from "@geolibre/map";
import type { ParseKeys } from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LatLon, parseLatLon } from "../../lib/coordinates";
import {
  type DmsAxis,
  decimalToDmsAxis,
  dmsAxisToDecimal,
} from "../../lib/dms";

interface SetViewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}

/** How the center coordinate is entered: decimal degrees or degrees/min/sec. */
type CoordFormat = "dd" | "dms";

/** The five editable camera fields, kept as strings so inputs can be cleared. */
interface ViewFields {
  longitude: string;
  latitude: string;
  zoom: string;
  pitch: string;
  bearing: string;
}

/** The center coordinate as DMS parts, the editable counterpart of lon/lat. */
interface DmsFields {
  lon: DmsAxis;
  lat: DmsAxis;
}

const EMPTY_FIELDS: ViewFields = {
  longitude: "",
  latitude: "",
  zoom: "",
  pitch: "",
  bearing: "",
};

const EMPTY_DMS: DmsFields = {
  lon: { deg: "", min: "", sec: "", dir: "E" },
  lat: { deg: "", min: "", sec: "", dir: "N" },
};

/** Round a value for display so prefilled fields aren't 15-digit floats. */
function round(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toString();
}

/**
 * Lets the user jump the map to an exact camera by typing the center longitude/
 * latitude (as decimal degrees or degrees/minutes/seconds), zoom, pitch, and
 * bearing — the editable counterpart to the View State readout. Prefilled with
 * the live camera each time it opens; submitting animates the map there via the
 * controller's `flyTo`.
 */
export function SetViewDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: SetViewDialogProps) {
  const { t } = useTranslation();
  const [fields, setFields] = useState<ViewFields>(EMPTY_FIELDS);
  const [dms, setDms] = useState<DmsFields>(EMPTY_DMS);
  const [format, setFormat] = useState<CoordFormat>("dd");
  const [error, setError] = useState<string | null>(null);
  // The smart-paste box: a full coordinate string in DD/DMS/DDM that, when it
  // parses, fills the precise fields below so users need not split it by hand.
  // The parse result is held alongside it so the failed-hint check and the fill
  // share one parse rather than re-running it on every render.
  const [paste, setPaste] = useState("");
  const [parsedCoord, setParsedCoord] = useState<LatLon | null>(null);

  // Seed both coordinate representations from the live camera whenever the
  // dialog opens, so switching DD<->DMS shows the same point either way.
  useEffect(() => {
    if (!open) return;
    const view = mapControllerRef.current?.readView();
    if (!view) return;
    const [longitude, latitude] = view.center;
    setFields({
      longitude: round(longitude, 6),
      latitude: round(latitude, 6),
      zoom: round(view.zoom, 3),
      pitch: round(view.pitch, 1),
      bearing: round(view.bearing, 1),
    });
    setDms({
      lon: decimalToDmsAxis(longitude, "lon"),
      lat: decimalToDmsAxis(latitude, "lat"),
    });
    // Reopen with a clean slate: everything else is reseeded, so reset the
    // format too rather than carrying over the last session's DD/DMS choice.
    setFormat("dd");
    setError(null);
    setPaste("");
    setParsedCoord(null);
  }, [open, mapControllerRef]);

  const update = (key: keyof ViewFields) => (value: string) =>
    setFields((current) => ({ ...current, [key]: value }));

  const updateDms =
    (axis: keyof DmsFields, part: keyof DmsAxis) => (value: string) =>
      setDms((current) => ({
        ...current,
        [axis]: { ...current[axis], [part]: value },
      }));

  // Switching format converts the current center across so no entry is lost: an
  // edit made in one format carries into the other instead of resetting.
  const changeFormat = (next: CoordFormat) => {
    if (next === format) return;
    if (next === "dms") {
      // A blank DD field must stay blank in DMS, not become 0 0 0 (Number("")
      // is 0); decimalToDmsAxis(NaN) returns empty parts.
      const toNum = (value: string) =>
        value.trim() === "" ? Number.NaN : Number(value);
      setDms({
        lon: decimalToDmsAxis(toNum(fields.longitude), "lon"),
        lat: decimalToDmsAxis(toNum(fields.latitude), "lat"),
      });
    } else {
      const longitude = dmsAxisToDecimal(dms.lon, "lon");
      const latitude = dmsAxisToDecimal(dms.lat, "lat");
      setFields((current) => ({
        ...current,
        longitude: Number.isFinite(longitude) ? round(longitude, 6) : "",
        latitude: Number.isFinite(latitude) ? round(latitude, 6) : "",
      }));
    }
    setError(null);
    setFormat(next);
  };

  // Parse a pasted/typed coordinate string and, when it decodes, fill both the
  // DD fields and the DMS parts so the change shows in whichever format is
  // active. Unrecognized text is left in the box and flagged inline below.
  const handlePaste = (value: string) => {
    setPaste(value);
    const parsed = parseLatLon(value);
    setParsedCoord(parsed);
    if (!parsed) return;
    setFields((current) => ({
      ...current,
      longitude: round(parsed.lon, 6),
      latitude: round(parsed.lat, 6),
    }));
    setDms({
      lon: decimalToDmsAxis(parsed.lon, "lon"),
      lat: decimalToDmsAxis(parsed.lat, "lat"),
    });
    setError(null);
  };

  // True only when there is text that failed to parse, so the hint can switch
  // from neutral guidance to an error without flagging an empty box.
  const pasteFailed = paste.trim() !== "" && parsedCoord === null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    // A blank required field must be rejected, not coerced: Number("") is 0, so
    // an empty zoom would otherwise fly to the whole-earth view and an empty
    // longitude/latitude would land on null island.
    const num = (value: string) => (value.trim() === "" ? NaN : Number(value));
    // Read the center from whichever format is active; dmsAxisToDecimal returns
    // NaN for out-of-range minutes/seconds, caught by the finite check below.
    const longitude =
      format === "dd" ? num(fields.longitude) : dmsAxisToDecimal(dms.lon, "lon");
    const latitude =
      format === "dd" ? num(fields.latitude) : dmsAxisToDecimal(dms.lat, "lat");
    const zoom = num(fields.zoom);
    // Pitch and bearing default to 0 (north-up, flat) when left blank.
    const pitch = fields.pitch.trim() === "" ? 0 : Number(fields.pitch);
    const bearing = fields.bearing.trim() === "" ? 0 : Number(fields.bearing);

    const finite = (value: number) => Number.isFinite(value);
    // Reject negative zoom/pitch (always invalid: MapLibre's minZoom/minPitch
    // are >= 0) with feedback rather than a silent clamp. Upper bounds are left
    // to MapLibre, since maxZoom/maxPitch are configurable per project.
    if (
      !finite(longitude) ||
      longitude < -180 ||
      longitude > 180 ||
      !finite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !finite(zoom) ||
      zoom < 0 ||
      !finite(pitch) ||
      pitch < 0 ||
      !finite(bearing)
    ) {
      setError(
        t(
          format === "dms"
            ? "toolbar.setView.invalidDms"
            : "toolbar.setView.invalid",
        ),
      );
      return;
    }

    // MapLibre clamps zoom/pitch to the map's configured limits.
    mapControllerRef.current?.flyTo({
      center: [longitude, latitude],
      zoom,
      pitch,
      bearing,
    });
    onOpenChange(false);
  };

  /** A labeled decimal-number input bound to one of the plain ViewFields. */
  const field = (
    key: keyof ViewFields,
    labelKey: ParseKeys,
    step: string,
    bounds?: { min?: number; max?: number },
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={`set-view-${key}`}>{t(labelKey)}</Label>
      <Input
        id={`set-view-${key}`}
        type="number"
        inputMode="decimal"
        step={step}
        min={bounds?.min}
        max={bounds?.max}
        value={fields[key]}
        onChange={(event) => update(key)(event.target.value)}
      />
    </div>
  );

  /** One DMS axis row: degrees / minutes / seconds inputs plus a hemisphere. */
  const dmsAxisRow = (
    axis: keyof DmsFields,
    labelKey: ParseKeys,
    degMax: number,
    hemispheres: readonly [string, string],
  ) => {
    const parts = dms[axis];
    const part = (
      partKey: keyof DmsAxis,
      partLabel: ParseKeys,
      max: number,
      symbol: string,
    ) => (
      <Input
        id={`set-view-${axis}-${partKey}`}
        type="number"
        inputMode="decimal"
        step="any"
        min={0}
        max={max}
        placeholder={symbol}
        aria-label={`${t(labelKey)} ${t(partLabel)}`}
        value={parts[partKey]}
        onChange={(event) => updateDms(axis, partKey)(event.target.value)}
      />
    );
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`set-view-${axis}-deg`}>{t(labelKey)}</Label>
        <div className="grid grid-cols-[repeat(3,minmax(0,1fr))_auto] gap-2">
          {/* Minutes/seconds cap just under 60 to match the [0, 60) the
              validator accepts, so the spinner can't reach a rejected value. */}
          {part("deg", "toolbar.setView.degrees", degMax, "°")}
          {part("min", "toolbar.setView.minutes", 59.999, "′")}
          {part("sec", "toolbar.setView.seconds", 59.999, "″")}
          <Select
            id={`set-view-${axis}-dir`}
            className="w-16"
            aria-label={`${t(labelKey)} ${t("toolbar.setView.hemisphere")}`}
            value={parts.dir}
            onChange={(event) => updateDms(axis, "dir")(event.target.value)}
          >
            {hemispheres.map((letter) => (
              <option key={letter} value={letter}>
                {letter}
              </option>
            ))}
          </Select>
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("toolbar.setView.title")}</DialogTitle>
          <DialogDescription>
            {t("toolbar.setView.description")}
          </DialogDescription>
        </DialogHeader>

        {/*
          noValidate: the prefilled camera is read straight from the live map,
          so any field whose step doesn't evenly divide its value violates the
          input's step constraint — most often zoom (e.g. 2.427 against
          step="0.1"), but pitch (45.3 against step="1") the same way. Native
          HTML5 validation would block submission of an unchanged prefill (and,
          in comma-decimal locales, reject the comma-formatted display as
          invalid) before handleSubmit ever runs. We do our own thorough,
          localized validation below, so let that be the single source of
          truth. */}
        <form className="space-y-5" noValidate onSubmit={handleSubmit}>
          {/* Segment A: coordinates, with a DD/DMS format toggle. */}
          <section className="space-y-3">
            <SectionHeading>
              {t("toolbar.setView.sectionCoordinates")}
            </SectionHeading>
            {/* Smart paste: drop a full coordinate string in any common notation
                and the precise fields below fill in, so there is no need to
                strip symbols or split the value by hand (#719). */}
            <div className="space-y-1.5">
              <Label htmlFor="set-view-paste">
                {t("toolbar.setView.smartPaste")}
              </Label>
              <Input
                id="set-view-paste"
                value={paste}
                placeholder={t("toolbar.setView.smartPastePlaceholder")}
                aria-invalid={pasteFailed || undefined}
                onChange={(event) => handlePaste(event.target.value)}
              />
              <p
                className={cn(
                  "text-xs",
                  pasteFailed ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {pasteFailed
                  ? t("toolbar.setView.smartPasteInvalid")
                  : t("toolbar.setView.smartPasteHint")}
              </p>
            </div>
            {/* Native radios (not buttons) so the browser gives the group its
                roving tabindex and arrow-key navigation for free; each input is
                absolutely positioned over its label so it stays clickable while
                the label carries the segmented-control styling. */}
            <div
              role="radiogroup"
              aria-label={t("toolbar.setView.format")}
              className="grid grid-cols-2 gap-1 rounded-md border border-input p-1"
            >
              {(
                [
                  ["dd", "toolbar.setView.formatDdShort", "toolbar.setView.formatDd"],
                  ["dms", "toolbar.setView.formatDmsShort", "toolbar.setView.formatDms"],
                ] as const
              ).map(([value, shortKey, fullKey]) => (
                <label
                  key={value}
                  title={t(fullKey)}
                  className={cn(
                    "relative cursor-pointer rounded-sm px-3 py-1 text-center text-sm font-medium transition-colors",
                    "focus-within:outline-none focus-within:ring-2 focus-within:ring-ring",
                    format === value
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  <input
                    type="radio"
                    name="set-view-coord-format"
                    value={value}
                    checked={format === value}
                    onChange={() => changeFormat(value)}
                    className="absolute inset-0 m-0 cursor-pointer opacity-0"
                  />
                  {t(shortKey)}
                </label>
              ))}
            </div>

            {format === "dd" ? (
              <div className="grid grid-cols-2 gap-3">
                {field("longitude", "toolbar.setView.longitude", "any", {
                  min: -180,
                  max: 180,
                })}
                {field("latitude", "toolbar.setView.latitude", "any", {
                  min: -90,
                  max: 90,
                })}
              </div>
            ) : (
              <div className="space-y-3">
                {dmsAxisRow("lon", "toolbar.setView.longitude", 180, ["E", "W"])}
                {dmsAxisRow("lat", "toolbar.setView.latitude", 90, ["N", "S"])}
              </div>
            )}
          </section>

          {/* Segment B: zoom on its own full-width row. */}
          <section className="space-y-3">
            <SectionHeading>{t("toolbar.setView.sectionZoom")}</SectionHeading>
            {field("zoom", "toolbar.setView.zoom", "0.1", { min: 0 })}
          </section>

          {/* Segment C: pitch and bearing paired, the camera rotation controls. */}
          <section className="space-y-3">
            <SectionHeading>
              {t("toolbar.setView.sectionOrientation")}
            </SectionHeading>
            <div className="grid grid-cols-2 gap-3">
              {field("pitch", "toolbar.setView.pitch", "1", { min: 0 })}
              {field("bearing", "toolbar.setView.bearing", "1")}
            </div>
          </section>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit">{t("toolbar.setView.go")}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A small uppercase label that titles each of the dialog's three segments. */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}
