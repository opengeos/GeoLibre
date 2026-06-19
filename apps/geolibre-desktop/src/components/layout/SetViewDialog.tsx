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
    const longitude = Number(fields.longitude);
    const latitude = Number(fields.latitude);
    const zoom = Number(fields.zoom);
    // Pitch and bearing default to 0 (north-up, flat) when left blank.
    const pitch = fields.pitch.trim() === "" ? 0 : Number(fields.pitch);
    const bearing = fields.bearing.trim() === "" ? 0 : Number(fields.bearing);

    const finite = (value: number) => Number.isFinite(value);
    if (
      !finite(longitude) ||
      longitude < -180 ||
      longitude > 180 ||
      !finite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !finite(zoom) ||
      !finite(pitch) ||
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

  const field = (key: keyof ViewFields, labelKey: ParseKeys, step: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={`set-view-${key}`}>{t(labelKey)}</Label>
      <Input
        id={`set-view-${key}`}
        type="number"
        inputMode="decimal"
        step={step}
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

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="grid grid-cols-2 gap-3">
            {field("longitude", "toolbar.setView.longitude", "any")}
            {field("latitude", "toolbar.setView.latitude", "any")}
            {field("zoom", "toolbar.setView.zoom", "0.1")}
            {field("pitch", "toolbar.setView.pitch", "1")}
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
