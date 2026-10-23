import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Input,
  Label,
  Select,
} from "@geolibre/ui";
import type { TimeSliderBinding } from "./useTimeSliderBinding";

interface BindTimeSliderDialogProps {
  /** The dialog state and handlers from useTimeSliderBinding. */
  binding: TimeSliderBinding;
}

/** The "Bind to Time Slider" dialog: pick a timestamp property, window and extent. */
export function BindTimeSliderDialog({ binding }: BindTimeSliderDialogProps) {
  const { t } = useTranslation();
  const {
    bindTimeSliderLayerId,
    bindCandidates,
    bindProperty,
    setBindProperty,
    bindWindowMode,
    setBindWindowMode,
    bindRecords,
    bindIsTileLayer,
    bindRangeStart,
    setBindRangeStart,
    bindRangeEnd,
    setBindRangeEnd,
    bindError,
    setBindError,
    prefillBindRange,
    closeBindTimeSliderDialog,
    confirmBindTimeSlider,
  } = binding;
  return (
    <Dialog
      open={!!bindTimeSliderLayerId}
      onOpenChange={(open: boolean) => {
        if (!open) closeBindTimeSliderDialog();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("layers.bindToTimeSlider")}</DialogTitle>
          <DialogDescription>{t("layers.bindDialogDescription")}</DialogDescription>
        </DialogHeader>
        {bindCandidates === null ? (
          <p className="text-sm text-muted-foreground">{t("layers.bindScanning")}</p>
        ) : bindCandidates.length === 0 ? (
          // A tile layer with nothing loaded has no sample to detect from,
          // which is a different problem from a layer whose columns are not
          // time-like — and one the user can fix by zooming to the layer.
          <p className="text-sm text-destructive">
            {bindIsTileLayer && (bindRecords?.length ?? 0) === 0
              ? t("layers.bindTileNoFeatures")
              : t("layers.bindNoProperty")}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="time-slider-property">{t("layers.bindProperty")}</Label>
              <Select
                id="time-slider-property"
                value={bindProperty}
                onChange={(event) => {
                  setBindProperty(event.target.value);
                  setBindError(null);
                  if (bindIsTileLayer && bindRecords) {
                    prefillBindRange(bindRecords, event.target.value);
                  }
                }}
              >
                {bindCandidates.map((candidate) => (
                  <option key={candidate.property} value={candidate.property}>
                    {candidate.property}
                    {candidate.coverage < 1 ? ` (${Math.round(candidate.coverage * 100)}%)` : ""}
                  </option>
                ))}
              </Select>
            </div>
            {bindIsTileLayer && (
              <div className="space-y-2">
                <Label htmlFor="time-slider-range-start">{t("layers.bindRange")}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="time-slider-range-start"
                    value={bindRangeStart}
                    onChange={(event) => {
                      setBindRangeStart(event.target.value);
                      setBindError(null);
                    }}
                  />
                  <span className="text-sm text-muted-foreground">–</span>
                  <Input
                    id="time-slider-range-end"
                    // The visible label names the start input, so the end
                    // input would otherwise be announced with no name.
                    aria-label={t("layers.bindRangeEnd")}
                    value={bindRangeEnd}
                    onChange={(event) => {
                      setBindRangeEnd(event.target.value);
                      setBindError(null);
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">{t("layers.bindRangeHint")}</p>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="time-slider-window">{t("layers.bindWindow")}</Label>
              <Select
                id="time-slider-window"
                value={bindWindowMode}
                onChange={(event) =>
                  setBindWindowMode(event.target.value as "step" | "wide" | "wider" | "cumulative")
                }
              >
                <option value="step">{t("layers.bindWindowStep")}</option>
                <option value="wide">{t("layers.bindWindowWide")}</option>
                <option value="wider">{t("layers.bindWindowWider")}</option>
                <option value="cumulative">{t("layers.bindWindowCumulative")}</option>
              </Select>
            </div>
            {bindError && <p className="text-sm text-destructive">{bindError}</p>}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={closeBindTimeSliderDialog}>
            {t("layers.bindCancel")}
          </Button>
          <Button type="button" disabled={!bindProperty} onClick={confirmBindTimeSlider}>
            {t("layers.bindConfirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
