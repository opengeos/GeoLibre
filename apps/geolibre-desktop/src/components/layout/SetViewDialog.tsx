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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@geolibre/ui";
import type { MapController } from "@geolibre/map";
import type { ParseKeys } from "i18next";
import { ChevronDown, ClipboardPaste, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseLatLon } from "../../lib/coordinates";
import {
  type DdmAxis,
  type DmsAxis,
  decimalToDdmAxis,
  decimalToDmsAxis,
  ddmAxisToDecimal,
  dmsAxisToDecimal,
} from "../../lib/dms";

interface SetViewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}

/**
 * How the center coordinate is entered by hand: decimal degrees, degrees/
 * minutes/seconds, or degrees/decimal-minutes. The smart-paste box above the
 * toggle accepts all three regardless of this choice.
 */
type CoordFormat = "dd" | "dms" | "ddm";

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

/** The center coordinate as DDM parts, the editable counterpart of lon/lat. */
interface DdmFields {
  lon: DdmAxis;
  lat: DdmAxis;
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

const EMPTY_DDM: DdmFields = {
  lon: { deg: "", min: "", dir: "E" },
  lat: { deg: "", min: "", dir: "N" },
};

/** Round a value for display so prefilled fields aren't 15-digit floats. */
function round(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toString();
}

/**
 * Lets the user jump the map to an exact camera by typing the center longitude/
 * latitude (as decimal degrees, degrees/minutes/seconds, or degrees/decimal-
 * minutes), zoom, pitch, and bearing — the editable counterpart to the View
 * State readout. Prefilled with the live camera each time it opens; submitting
 * animates the map there via the controller's `flyTo`.
 */
export function SetViewDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: SetViewDialogProps) {
  const { t } = useTranslation();
  const [fields, setFields] = useState<ViewFields>(EMPTY_FIELDS);
  const [dms, setDms] = useState<DmsFields>(EMPTY_DMS);
  const [ddm, setDdm] = useState<DdmFields>(EMPTY_DDM);
  const [format, setFormat] = useState<CoordFormat>("dd");
  const [error, setError] = useState<string | null>(null);
  // The smart-paste box: a full coordinate string in DD/DMS/DDM that fills the
  // precise fields below only when the user runs it with "Process input" (or
  // Enter), so the parse is an explicit, verifiable step rather than something
  // that mutates the fields on every keystroke (#828).
  const [paste, setPaste] = useState("");
  // Outcome of the most recent Process: "idle" (untouched), "ok" (fields
  // filled), or "error" (string could not be parsed). Reset to "idle" on any
  // edit so a stale confirmation/warning never lingers.
  const [pasteStatus, setPasteStatus] = useState<"idle" | "ok" | "error">(
    "idle",
  );
  // The smart-paste field lives behind a clearly labeled, always-visible toggle
  // button under the heading: the dialog still leads with the precise fields and
  // the paste shortcut adds no clutter by default (#828), while the button gives
  // the shortcut an obvious affordance instead of hiding it behind a hover-only
  // icon (#1033). Collapsed each time the dialog opens; clicking toggles it.
  const [pasteOpen, setPasteOpen] = useState(false);

  // Fill all three center representations from one decimal lon/lat, so the value
  // is in place whichever format the user switches to or submits in.
  const fillFromDecimal = (lon: number, lat: number) => {
    setFields((current) => ({
      ...current,
      longitude: Number.isFinite(lon) ? round(lon, 6) : "",
      latitude: Number.isFinite(lat) ? round(lat, 6) : "",
    }));
    setDms({
      lon: decimalToDmsAxis(lon, "lon"),
      lat: decimalToDmsAxis(lat, "lat"),
    });
    setDdm({
      lon: decimalToDdmAxis(lon, "lon"),
      lat: decimalToDdmAxis(lat, "lat"),
    });
  };

  // Seed every coordinate representation from the live camera whenever the
  // dialog opens, so switching DD/DMS/DDM shows the same point either way.
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
    setDdm({
      lon: decimalToDdmAxis(longitude, "lon"),
      lat: decimalToDdmAxis(latitude, "lat"),
    });
    // Reopen with a clean slate: everything else is reseeded, so reset the
    // format too rather than carrying over the last session's DD/DMS/DDM choice.
    setFormat("dd");
    setError(null);
    setPaste("");
    setPasteStatus("idle");
    setPasteOpen(false);
  }, [open, mapControllerRef]);

  // Editing the longitude/latitude by hand dismisses a stale Process
  // confirmation/warning, since those shown values no longer came from the paste
  // box. Zoom/pitch/bearing are independent of the pasted center, so editing
  // them must not clear the confirmation.
  const update = (key: keyof ViewFields) => (value: string) => {
    if (key === "longitude" || key === "latitude") setPasteStatus("idle");
    setFields((current) => ({ ...current, [key]: value }));
  };

  const updateDms =
    (axis: keyof DmsFields, part: keyof DmsAxis) => (value: string) => {
      setPasteStatus("idle");
      setDms((current) => ({
        ...current,
        [axis]: { ...current[axis], [part]: value },
      }));
    };

  const updateDdm =
    (axis: keyof DdmFields, part: keyof DdmAxis) => (value: string) => {
      setPasteStatus("idle");
      setDdm((current) => ({
        ...current,
        [axis]: { ...current[axis], [part]: value },
      }));
    };

  // The center as decimal lon/lat read from whichever format is active. A blank
  // field becomes NaN (not 0, since Number("") is 0), and the DMS/DDM helpers
  // return NaN for out-of-range parts, both caught by the finite check on submit.
  const readCenterDecimal = (): { lon: number; lat: number } => {
    if (format === "dd") {
      const toNum = (value: string) =>
        value.trim() === "" ? Number.NaN : Number(value);
      return { lon: toNum(fields.longitude), lat: toNum(fields.latitude) };
    }
    if (format === "dms") {
      return {
        lon: dmsAxisToDecimal(dms.lon, "lon"),
        lat: dmsAxisToDecimal(dms.lat, "lat"),
      };
    }
    return {
      lon: ddmAxisToDecimal(ddm.lon, "lon"),
      lat: ddmAxisToDecimal(ddm.lat, "lat"),
    };
  };

  // Switching format converts the current center across so no entry is lost: an
  // edit made in one format carries into the other instead of resetting. Blank
  // (NaN) stays blank because the *ToAxis helpers return empty parts for NaN.
  const changeFormat = (next: CoordFormat) => {
    if (next === format) return;
    const { lon, lat } = readCenterDecimal();
    if (next === "dd") {
      setFields((current) => ({
        ...current,
        longitude: Number.isFinite(lon) ? round(lon, 6) : "",
        latitude: Number.isFinite(lat) ? round(lat, 6) : "",
      }));
    } else if (next === "dms") {
      setDms({
        lon: decimalToDmsAxis(lon, "lon"),
        lat: decimalToDmsAxis(lat, "lat"),
      });
    } else {
      setDdm({
        lon: decimalToDdmAxis(lon, "lon"),
        lat: decimalToDdmAxis(lat, "lat"),
      });
    }
    setError(null);
    setFormat(next);
  };

  // Typing only updates the box and clears any prior outcome; the parse waits
  // for an explicit Process so the manual fields are never mutated mid-keystroke.
  const handlePaste = (value: string) => {
    setPaste(value);
    setPasteStatus("idle");
  };

  // The "Process input" action (button or Enter in the box): parse on demand and
  // fill the DD, DMS, and DDM fields so the result shows in whichever format is
  // active, confirming inline without closing the dialog so a novice can verify
  // it before going. Unrecognized text is left in place and flagged below.
  const handleProcess = () => {
    if (paste.trim() === "") return;
    const parsed = parseLatLon(paste);
    if (!parsed) {
      setPasteStatus("error");
      return;
    }
    fillFromDecimal(parsed.lon, parsed.lat);
    setError(null);
    setPasteStatus("ok");
  };

  // True only when a Process attempt failed to parse, so the hint flags a bad
  // string without flagging an empty box or text the user is still typing.
  const pasteFailed = pasteStatus === "error";

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    // A blank required field must be rejected, not coerced: Number("") is 0, so
    // an empty zoom would otherwise fly to the whole-earth view and an empty
    // longitude/latitude would land on null island.
    const num = (value: string) => (value.trim() === "" ? NaN : Number(value));
    // Read the center from whichever format is active; the DMS/DDM helpers
    // return NaN for out-of-range parts, caught by the finite check below.
    const { lon: longitude, lat: latitude } = readCenterDecimal();
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
            : format === "ddm"
              ? "toolbar.setView.invalidDdm"
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

  /** One DDM axis row: degrees / decimal-minutes inputs plus a hemisphere. */
  const ddmAxisRow = (
    axis: keyof DdmFields,
    labelKey: ParseKeys,
    degMax: number,
    hemispheres: readonly [string, string],
  ) => {
    const parts = ddm[axis];
    const part = (
      partKey: "deg" | "min",
      partLabel: ParseKeys,
      max: number,
      symbol: string,
    ) => (
      <Input
        id={`set-view-ddm-${axis}-${partKey}`}
        type="number"
        inputMode="decimal"
        step="any"
        min={0}
        max={max}
        placeholder={symbol}
        aria-label={`${t(labelKey)} ${t(partLabel)}`}
        value={parts[partKey]}
        onChange={(event) => updateDdm(axis, partKey)(event.target.value)}
      />
    );
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`set-view-ddm-${axis}-deg`}>{t(labelKey)}</Label>
        <div className="grid grid-cols-[repeat(2,minmax(0,1fr))_auto] gap-2">
          {/* Decimal minutes cap just under 60 to match the [0, 60) the
              validator accepts, so the spinner can't reach a rejected value.
              Same 59.999 ceiling as the DMS minutes/seconds fields. */}
          {part("deg", "toolbar.setView.degrees", degMax, "°")}
          {part("min", "toolbar.setView.minutes", 59.999, "′")}
          <Select
            id={`set-view-ddm-${axis}-dir`}
            className="w-16"
            aria-label={`${t(labelKey)} ${t("toolbar.setView.hemisphere")}`}
            value={parts.dir}
            onChange={(event) => updateDdm(axis, "dir")(event.target.value)}
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
          {/* Segment A: coordinates, with a DD/DMS/DDM manual-entry toggle. */}
          <section className="space-y-3">
            <SectionHeading>
              {t("toolbar.setView.sectionCoordinates")}
            </SectionHeading>
            {/* Smart paste sits behind a clearly labeled, always-visible toggle
                button: the panel stays collapsed so the dialog leads with the
                precise fields (#828), but the button gives the shortcut an
                obvious affordance rather than hiding it behind a hover-only icon
                (#1033). Clicking toggles the panel, which expands inline (not as
                a floating overlay) so it never covers the controls below it. */}
            <Button
              type="button"
              variant="outline"
              aria-expanded={pasteOpen}
              // Only reference the panel while it is actually mounted: it is
              // conditionally rendered below, so pointing aria-controls at a
              // missing id when collapsed would be a dangling reference.
              aria-controls={pasteOpen ? "set-view-paste-panel" : undefined}
              onClick={() => setPasteOpen((isOpen) => !isOpen)}
              className={cn(
                "w-full justify-start",
                pasteOpen ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <ClipboardPaste className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="flex-1 text-left">
                {t("toolbar.setView.smartPaste")}
              </span>
              <ChevronDown
                className={cn(
                  "h-4 w-4 shrink-0 transition-transform",
                  pasteOpen && "rotate-180",
                )}
                aria-hidden="true"
              />
            </Button>
            {pasteOpen && (
              <div
                id="set-view-paste-panel"
                className="space-y-1.5 rounded-md border bg-muted/30 p-3"
              >
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="set-view-paste">
                    {t("toolbar.setView.smartPasteInputLabel")}
                  </Label>
                  <InfoTooltip
                    title={t("toolbar.setView.smartPasteInfoLabel")}
                    label={t("toolbar.setView.smartPasteInfo")}
                  />
                </div>
                <Input
                  id="set-view-paste"
                  value={paste}
                  placeholder={t("toolbar.setView.smartPastePlaceholder")}
                  aria-invalid={pasteFailed || undefined}
                  onChange={(event) => handlePaste(event.target.value)}
                  onKeyDown={(event) => {
                    // Enter in the paste box processes the string instead of
                    // submitting the form, so the user can verify before going.
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleProcess();
                    }
                  }}
                />
                <div className="flex items-center justify-between gap-2">
                  {/* The hint stays neutral/empty until the user acts: it
                      confirms a successful Process, or flags text that failed to
                      parse. */}
                  <p
                    className={cn(
                      "text-xs",
                      pasteFailed
                        ? "text-destructive"
                        : "text-muted-foreground",
                    )}
                    aria-live="polite"
                  >
                    {pasteFailed
                      ? t("toolbar.setView.smartPasteInvalid")
                      : pasteStatus === "ok"
                        ? t("toolbar.setView.processed")
                        : ""}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={paste.trim() === ""}
                    onClick={handleProcess}
                  >
                    {t("toolbar.setView.processInput")}
                  </Button>
                </div>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <span
                id="set-view-format-label"
                className="text-sm font-medium leading-none"
              >
                {t("toolbar.setView.format")}
              </span>
              <InfoTooltip
                title={t("toolbar.setView.formatInfoLabel")}
                label={t("toolbar.setView.formatInfo")}
              />
            </div>
            {/* Native radios (not buttons) so the browser gives the group its
                roving tabindex and arrow-key navigation for free; each input is
                absolutely positioned over its label so it stays clickable while
                the label carries the segmented-control styling. */}
            <div
              role="radiogroup"
              aria-labelledby="set-view-format-label"
              className="grid grid-cols-3 gap-1 rounded-md border border-input p-1"
            >
              {(
                [
                  ["dd", "toolbar.setView.formatDdShort", "toolbar.setView.formatDd"],
                  ["dms", "toolbar.setView.formatDmsShort", "toolbar.setView.formatDms"],
                  ["ddm", "toolbar.setView.formatDdmShort", "toolbar.setView.formatDdm"],
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
            ) : format === "dms" ? (
              <div className="space-y-3">
                {dmsAxisRow("lon", "toolbar.setView.longitude", 180, ["E", "W"])}
                {dmsAxisRow("lat", "toolbar.setView.latitude", 90, ["N", "S"])}
              </div>
            ) : (
              <div className="space-y-3">
                {ddmAxisRow("lon", "toolbar.setView.longitude", 180, ["E", "W"])}
                {ddmAxisRow("lat", "toolbar.setView.latitude", 90, ["N", "S"])}
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
            <p className="text-xs text-muted-foreground">
              {t("toolbar.setView.orientationHint")}
            </p>
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

/**
 * A small info "ⓘ" button that reveals help text on hover/focus. `title` is the
 * short accessible name announced on focus, while `label` is the longer tooltip
 * content shown to sighted users, rendered with preserved line breaks so a
 * multi-line format reference reads as a list.
 */
function InfoTooltip({ title, label }: { title: string; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={title}
          className="inline-flex cursor-help rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-pre-line">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
