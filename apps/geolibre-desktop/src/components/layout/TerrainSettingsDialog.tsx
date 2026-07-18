import {
  DEFAULT_TERRAIN_EXAGGERATION,
  TERRAIN_SETTINGS_CLOSE_EVENT,
  TERRAIN_SETTINGS_EVENT,
  type MapController,
} from "@geolibre/map";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Slider,
} from "@geolibre/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  clampExaggeration,
  EXAGGERATION_STEP,
  MAX_EXAGGERATION,
  MIN_EXAGGERATION,
} from "../../lib/terrain-exaggeration";

// Default sourced from the map package so it can't drift from the control's.
const DEFAULT_EXAGGERATION = DEFAULT_TERRAIN_EXAGGERATION;

export interface TerrainSettingsDialogProps {
  mapControllerRef: React.RefObject<MapController | null>;
}

/**
 * Vertical-exaggeration dialog for 3D terrain. It is opened by double-clicking
 * the on-map terrain control, which dispatches {@link TERRAIN_SETTINGS_EVENT}
 * (the control lives outside React). The slider/number input applies changes
 * live via the map controller so the effect is visible while dragging.
 */
export function TerrainSettingsDialog({ mapControllerRef }: TerrainSettingsDialogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [exaggeration, setExaggeration] = useState(DEFAULT_EXAGGERATION);
  // Free-text draft for the number input so a fractional value like "2.5" can be
  // typed without the controlled numeric value snapping the field mid-keystroke.
  // Committed (parsed/clamped) on blur or Enter; kept in sync when the value
  // changes elsewhere (slider, dialog open, reset).
  const [draft, setDraft] = useState(String(DEFAULT_EXAGGERATION));
  useEffect(() => setDraft(String(exaggeration)), [exaggeration]);

  useEffect(() => {
    const handleOpen = () => {
      // Seed from the controller's current value so the dialog reflects any
      // previously chosen exaggeration. Clamp to the dialog's display range: the
      // controller only floors its cache at 0, so a value written directly (e.g.
      // via a future scripting API) could exceed the max. Set the draft directly
      // too (not just via the exaggeration effect) so reopening after an
      // uncommitted/invalid draft was abandoned via Escape shows the real value.
      const value = clampExaggeration(
        mapControllerRef.current?.getTerrainExaggeration() ?? DEFAULT_EXAGGERATION,
      );
      setExaggeration(value);
      setDraft(String(value));
      setOpen(true);
    };
    // Close if the terrain control is removed (e.g. hidden from the Controls
    // menu) while the dialog is open, so it isn't left responding with no effect.
    const handleClose = () => setOpen(false);
    window.addEventListener(TERRAIN_SETTINGS_EVENT, handleOpen);
    window.addEventListener(TERRAIN_SETTINGS_CLOSE_EVENT, handleClose);
    return () => {
      window.removeEventListener(TERRAIN_SETTINGS_EVENT, handleOpen);
      window.removeEventListener(TERRAIN_SETTINGS_CLOSE_EVENT, handleClose);
    };
  }, [mapControllerRef]);

  // Coalesce the live map update to one per animation frame so a fast slider
  // drag (Radix fires onValueChange on every 0.1 step) doesn't spray dozens of
  // setTerrain calls — each of which reprocesses the terrain mesh — per second.
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const applyExaggeration = (value: number) => {
    const clamped = clampExaggeration(value);
    setExaggeration(clamped);
    pendingRef.current = clamped;
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const next = pendingRef.current;
        pendingRef.current = null;
        if (next !== null) mapControllerRef.current?.setTerrainExaggeration(next);
      });
    }
  };

  const commitDraft = () => {
    const parsed = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      // Revert an empty/invalid draft to the last committed value.
      setDraft(String(exaggeration));
      return;
    }
    const clamped = clampExaggeration(parsed);
    applyExaggeration(clamped);
    // Reflect clamping in the field even when the state value is unchanged
    // (e.g. "7" committed while already at the max of 5).
    setDraft(String(clamped));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("terrainSettings.title")}</DialogTitle>
          <DialogDescription>{t("terrainSettings.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="terrain-exaggeration-input">{t("terrainSettings.label")}</Label>
              <Input
                id="terrain-exaggeration-input"
                type="number"
                inputMode="decimal"
                className="w-24"
                min={MIN_EXAGGERATION}
                max={MAX_EXAGGERATION}
                step={EXAGGERATION_STEP}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitDraft}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </div>
            <Slider
              aria-label={t("terrainSettings.label")}
              min={MIN_EXAGGERATION}
              max={MAX_EXAGGERATION}
              step={EXAGGERATION_STEP}
              value={[exaggeration]}
              onValueChange={(value: number[]) => applyExaggeration(value[0])}
            />
          </div>
          <div className="flex justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => applyExaggeration(DEFAULT_EXAGGERATION)}
            >
              {t("terrainSettings.reset")}
            </Button>
            <Button type="button" onClick={() => setOpen(false)}>
              {t("terrainSettings.done")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
