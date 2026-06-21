import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@geolibre/ui";
import type { MapController } from "@geolibre/map";
import type { ParseKeys } from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface SetViewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}

/** The five editable camera fields, kept as strings so inputs can be cleared. */
interface ViewFields {
  longitude: string;
  latitude: string;
  zoom: string;
  pitch: string;
  bearing: string;
}

const EMPTY_FIELDS: ViewFields = {
  longitude: "",
  latitude: "",
  zoom: "",
  pitch: "",
  bearing: "",
};

/** Round a value for display so prefilled fields aren't 15-digit floats. */
function round(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toString();
}

/**
 * Lets the user jump the map to an exact camera by typing the center longitude/
 * latitude, zoom, pitch, and bearing — the editable counterpart to the View
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
  const [error, setError] = useState<string | null>(null);

  // Seed the inputs from the live camera whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    const view = mapControllerRef.current?.readView();
    if (!view) return;
    setFields({
      longitude: round(view.center[0], 6),
      latitude: round(view.center[1], 6),
      zoom: round(view.zoom, 3),
      pitch: round(view.pitch, 1),
      bearing: round(view.bearing, 1),
    });
    setError(null);
  }, [open, mapControllerRef]);

  const update = (key: keyof ViewFields) => (value: string) =>
    setFields((current) => ({ ...current, [key]: value }));

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    // A blank required field must be rejected, not coerced: Number("") is 0, so
    // an empty zoom would otherwise fly to the whole-earth view and an empty
    // longitude/latitude would land on null island.
    const num = (value: string) => (value.trim() === "" ? NaN : Number(value));
    const longitude = num(fields.longitude);
    const latitude = num(fields.latitude);
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
      setError(t("toolbar.setView.invalid"));
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
          so the zoom is a fractional value like 2.427 that violates the input's
          step="0.1" constraint. Native HTML5 validation would block submission
          of an unchanged prefill (and, in comma-decimal locales, reject the
          comma-formatted display as invalid) before handleSubmit ever runs. We
          do our own thorough, localized validation below, so let that be the
          single source of truth. */}
        <form className="space-y-4" noValidate onSubmit={handleSubmit}>
          <div className="grid grid-cols-2 gap-3">
            {field("longitude", "toolbar.setView.longitude", "any", {
              min: -180,
              max: 180,
            })}
            {field("latitude", "toolbar.setView.latitude", "any", {
              min: -90,
              max: 90,
            })}
            {field("zoom", "toolbar.setView.zoom", "0.1", { min: 0 })}
            {field("pitch", "toolbar.setView.pitch", "1", { min: 0 })}
            {field("bearing", "toolbar.setView.bearing", "1")}
          </div>

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
