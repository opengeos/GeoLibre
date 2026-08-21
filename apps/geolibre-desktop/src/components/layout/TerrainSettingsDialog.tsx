import {
  CogDemError,
  DEFAULT_TERRAIN_EXAGGERATION,
  TERRAIN_SETTINGS_CLOSE_EVENT,
  TERRAIN_SETTINGS_EVENT,
  type CogDemErrorCode,
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

// @geolibre/map is i18n-agnostic and throws English messages, so the failure
// kinds it tags are mapped to the catalog here rather than shown verbatim.
const SOURCE_ERROR_KEYS = {
  "empty-source": "terrainSettings.sourceErrorEmpty",
  "unsupported-band": "terrainSettings.sourceErrorBand",
  "unsupported-projection": "terrainSettings.sourceErrorProjection",
} as const satisfies Record<CogDemErrorCode, string>;

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
  const [terrainUrl, setTerrainUrl] = useState("");
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
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
      setTerrainUrl(mapControllerRef.current?.getTerrainCogSource() ?? "");
      setSourceError(null);
      // A COG still opening from a previous session of this dialog would
      // otherwise leave the controls disabled and the button reading "Opening
      // COG…" with nothing in flight that the user can see. Its own finally
      // clears the flag again; a second request racing it is settled by the
      // controller, which reports the superseded one as not applied.
      setSourceLoading(false);
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
  const sourceRequestRef = useRef(0);
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

  // Anything the map package did not tag — a network or decode failure — keeps
  // its message as detail inside a translated sentence, so the user still sees
  // why it failed without the whole line arriving in English.
  const translateSourceError = (error: unknown): string => {
    if (error instanceof CogDemError) return t(SOURCE_ERROR_KEYS[error.code]);
    const detail = error instanceof Error ? error.message.trim() : "";
    return detail
      ? t("terrainSettings.sourceErrorDetail", { detail })
      : t("terrainSettings.sourceError");
  };

  // Optional chaining on the ref would resolve to undefined and read as a
  // successful source change, leaving the dialog claiming a switch that never
  // happened. Surface the failure instead.
  const applyTerrainSource = async (source: string | File | null, onApplied?: () => void) => {
    const controller = mapControllerRef.current;
    if (!controller) {
      setSourceError(t("terrainSettings.sourceError"));
      return;
    }
    // Requests share the loading and error state, so an older one settling late
    // would clear the spinner or post its error over a newer request that is
    // still running. Only the newest touches that state.
    const request = ++sourceRequestRef.current;
    const isCurrent = () => sourceRequestRef.current === request;
    setSourceLoading(true);
    setSourceError(null);
    try {
      // False means another caller's newer selection won, so this request must
      // not clear the field or otherwise report itself as the applied source.
      if ((await controller.setTerrainCogSource(source)) && isCurrent()) onApplied?.();
    } catch (error) {
      if (isCurrent()) setSourceError(translateSourceError(error));
    } finally {
      if (isCurrent()) setSourceLoading(false);
    }
  };

  const applyCogSource = () => applyTerrainSource(terrainUrl);

  // Keep the URL input empty: a local filename is not a fetchable URL, and
  // leaving it in this field would let a later "Use COG DEM" click try to open
  // it as an HTTP source.
  const applyLocalCogSource = (file: File) => applyTerrainSource(file, () => setTerrainUrl(""));

  const restoreDefaultSource = () => applyTerrainSource(null, () => setTerrainUrl(""));

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
          <div className="space-y-2 border-t pt-4">
            <Label htmlFor="terrain-cog-url">{t("terrainSettings.sourceLabel")}</Label>
            <p className="text-muted-foreground text-sm">
              {t("terrainSettings.sourceDescription")}
            </p>
            <Input
              id="terrain-cog-url"
              type="url"
              inputMode="url"
              placeholder={t("terrainSettings.sourcePlaceholder")}
              value={terrainUrl}
              disabled={sourceLoading || !mapControllerRef.current}
              onChange={(event) => setTerrainUrl(event.target.value)}
              onKeyDown={(event) => {
                // Gated like the button: a second Enter before React repaints
                // would otherwise start an overlapping request.
                if (event.key === "Enter" && !sourceLoading && terrainUrl.trim()) {
                  void applyCogSource();
                }
              }}
            />
            <div className="space-y-1">
              <Label htmlFor="terrain-cog-file">{t("terrainSettings.localSourceLabel")}</Label>
              <Input
                id="terrain-cog-file"
                type="file"
                accept=".tif,.tiff,image/tiff"
                disabled={sourceLoading || !mapControllerRef.current}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void applyLocalCogSource(file);
                  event.currentTarget.value = "";
                }}
              />
              <p className="text-muted-foreground text-xs">
                {t("terrainSettings.localSourceDescription")}
              </p>
            </div>
            {sourceError ? (
              <p className="text-destructive text-sm" role="alert">
                {sourceError}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={sourceLoading || !terrainUrl.trim() || !mapControllerRef.current}
                onClick={() => void applyCogSource()}
              >
                {sourceLoading ? t("terrainSettings.sourceLoading") : t("terrainSettings.useCog")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={sourceLoading || !mapControllerRef.current?.hasCustomTerrainSource()}
                onClick={() => void restoreDefaultSource()}
              >
                {t("terrainSettings.restoreDefaultSource")}
              </Button>
            </div>
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
