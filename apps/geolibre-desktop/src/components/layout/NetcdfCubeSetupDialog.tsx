import type { MapController } from "@geolibre/map";
import type { LocalNetcdfAxis } from "@geolibre/plugins";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
} from "@geolibre/ui";
import { Boxes, SquareDashed } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { bandLabel, defaultRgbBands, MAX_AXIS_OPTIONS } from "../../lib/netcdf-band-axis";
import {
  bandChoicesFor,
  closeNetcdfCube,
  getNetcdfCubeState,
  normalizeCubeSettings,
  resumeNetcdfCube,
  SIZE_CHOICES,
  startNetcdfCube,
  subscribeNetcdfCube,
  type CubeExtentMode,
  type NetcdfCubeSettings,
} from "../../lib/netcdf-cube-store";
import { getNetcdfLayerState } from "../../lib/netcdf-image-symbology";
import { clearPrintExtent, drawPrintExtent } from "../../lib/print-extent";

interface NetcdfCubeSetupDialogProps {
  /** The live map, for "use the current view" and for drawing an extent. */
  mapControllerRef: React.RefObject<MapController | null>;
}

/**
 * Settings for a 3-D cube, collected before anything is read.
 *
 * The dialog exists because a cube read is expensive and irreversible in the
 * only sense that matters to a user: it takes tens of seconds, so starting one
 * with the wrong extent or band count means waiting it out and starting again.
 * Every choice here changes what gets read, which is why they are all in front
 * of the read rather than behind it.
 *
 * @param props.mapControllerRef - The map the extent is taken or drawn from.
 * @returns The dialog, or null when no layer is in setup.
 */
export function NetcdfCubeSetupDialog({ mapControllerRef }: NetcdfCubeSetupDialogProps) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(subscribeNetcdfCube, getNetcdfCubeState, getNetcdfCubeState);
  const open = state.layerId !== null && state.phase === "setup";

  const [draft, setDraft] = useState<NetcdfCubeSettings>(state.settings);
  const [drawing, setDrawing] = useState(false);
  // The layer a draft belongs to, so opening the dialog on a different layer
  // reloads it rather than keeping the previous layer's band indices — which
  // may not even exist on the new one's axis.
  const [draftLayerId, setDraftLayerId] = useState<string | null>(state.layerId);
  const drawAbort = useRef<AbortController | null>(null);

  const layerState = state.layerId ? getNetcdfLayerState(state.layerId) : null;
  const axis: LocalNetcdfAxis | null = layerState?.cube?.axis ?? null;

  if (open && draftLayerId !== state.layerId && axis) {
    setDraftLayerId(state.layerId);
    // Through the normaliser, because the carried settings were chosen against
    // some other layer: its drawn bbox is somewhere else entirely, and its band
    // indices may not exist on this axis.
    // `keepExtent: false` unconditionally: this block only runs when the layer
    // changed, and a same-layer reopen never re-seeds the draft at all, so its
    // bbox survives untouched by not passing through here.
    setDraft(normalizeCubeSettings(state.settings, axis.size, false, defaultRgbBands(axis)));
  }

  // Abandon an armed draw if the dialog closes under it; the map would
  // otherwise stay in crosshair mode with panning disabled.
  useEffect(() => {
    if (open) return;
    drawAbort.current?.abort();
    drawAbort.current = null;
    setDrawing(false);
  }, [open]);

  if (!open || !axis) return null;

  const bandChoices = bandChoicesFor(axis.size);
  // The draft is normalised against this axis when it is seeded, so the value is
  // always one of the offered options — which is what keeps the field, the plane
  // estimate, and what gets submitted describing the same read.
  const selectedBands = draft.maxBands;
  const rgbBands = draft.rgbBands ?? defaultRgbBands(axis);

  // While a draw is armed the dialog steps aside entirely: it is modal, and its
  // overlay would otherwise swallow the very drag being asked for — and even
  // without the overlay, a box covering the middle of the screen is the wrong
  // thing to have in front of a map you are picking an extent on. The component
  // stays mounted, so the draft comes back untouched with the extent filled in.
  if (drawing) {
    return (
      <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4">
        <div className="pointer-events-auto flex items-center gap-3 rounded-lg border bg-background/95 px-4 py-2 text-sm shadow-lg">
          <SquareDashed className="h-4 w-4 text-primary" aria-hidden="true" />
          <span>{t("netcdfCube.drawing")}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => drawAbort.current?.abort()}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  const startDraw = async (): Promise<void> => {
    const map = mapControllerRef.current?.getMap();
    if (!map) return;
    drawAbort.current?.abort();
    const controller = new AbortController();
    drawAbort.current = controller;
    setDrawing(true);
    try {
      // The shared box-draw the Print layout uses: it suspends the map gestures
      // that would fight the drag, handles touch and Escape, and hands back
      // [west, south, east, north].
      const extent = await drawPrintExtent(map, { signal: controller.signal });
      if (extent) setDraft((current) => ({ ...current, extent: "draw", bbox: extent }));
    } finally {
      // The box it leaves behind belongs to the Print layout's source; clear it
      // so a cube extent does not linger on the map as a print frame.
      clearPrintExtent(map);
      if (drawAbort.current === controller) drawAbort.current = null;
      setDrawing(false);
    }
  };

  // Cancelling a *reopened* dialog goes back to the cube already in memory;
  // cancelling the first one has nothing to go back to and closes.
  const dismiss = (): void => {
    if (state.started) resumeNetcdfCube();
    else closeNetcdfCube();
  };

  const setRgbBand = (channel: number, index: number): void => {
    const next: [number, number, number] = [...rgbBands];
    next[channel] = index;
    setDraft((current) => ({ ...current, rgbBands: next }));
  };

  // Every band plane is a separate read, so this is what the wait is
  // proportional to. Showing it here is the only chance the user gets to trade
  // it against detail before committing.
  const planeCount = selectedBands + (draft.rgbBands ? 3 : 0);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Boxes className="h-5 w-5" aria-hidden="true" />
            {t("netcdfCube.setupTitle")}
          </DialogTitle>
          <DialogDescription>{t("netcdfCube.setupDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="netcdfCubeExtent">{t("netcdfCube.extent")}</Label>
            <Select
              id="netcdfCubeExtent"
              value={draft.extent}
              onChange={(event) =>
                setDraft({ ...draft, extent: event.target.value as CubeExtentMode })
              }
            >
              <option value="view">{t("netcdfCube.extentView")}</option>
              <option value="draw">{t("netcdfCube.extentDraw")}</option>
              <option value="full">{t("netcdfCube.extentFull")}</option>
            </Select>
            {draft.extent === "draw" ? (
              <div className="space-y-1.5">
                <Button
                  type="button"
                  variant={drawing ? "secondary" : "outline"}
                  size="sm"
                  aria-pressed={drawing}
                  onClick={() => void startDraw()}
                >
                  <SquareDashed className="me-1.5 h-4 w-4" aria-hidden="true" />
                  {drawing ? t("netcdfCube.drawing") : t("netcdfCube.drawBbox")}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {draft.bbox
                    ? t("netcdfCube.drawnExtent", {
                        west: draft.bbox[0].toFixed(4),
                        south: draft.bbox[1].toFixed(4),
                        east: draft.bbox[2].toFixed(4),
                        north: draft.bbox[3].toFixed(4),
                      })
                    : t("netcdfCube.drawHint")}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {draft.extent === "full" ? t("netcdfCube.fullHint") : t("netcdfCube.viewHint")}
              </p>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="netcdfCubeDetail">{t("netcdfCube.detail")}</Label>
              <Select
                id="netcdfCubeDetail"
                value={String(draft.maxSize)}
                onChange={(event) => setDraft({ ...draft, maxSize: Number(event.target.value) })}
              >
                {SIZE_CHOICES.map((choice) => (
                  <option key={choice} value={choice}>
                    {t("netcdfCube.detailOption", { size: choice })}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="netcdfCubeBands">{t("netcdfCube.bands")}</Label>
              <Select
                id="netcdfCubeBands"
                value={String(selectedBands)}
                onChange={(event) => setDraft({ ...draft, maxBands: Number(event.target.value) })}
              >
                {bandChoices.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice >= axis.size ? t("netcdfCube.allBands", { count: axis.size }) : choice}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.rgbBands !== null}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    rgbBands: event.target.checked ? defaultRgbBands(axis) : null,
                  })
                }
              />
              {t("netcdfCube.rgbOverlay")}
            </label>
            <p className="text-xs text-muted-foreground">{t("netcdfCube.rgbHint")}</p>
            {draft.rgbBands ? (
              <div className="grid gap-2 sm:grid-cols-3">
                {(["red", "green", "blue"] as const).map((channel, index) => (
                  <div key={channel} className="space-y-1.5">
                    <Label htmlFor={`netcdfCubeRgb-${channel}`}>{t(`netcdfCube.${channel}`)}</Label>
                    <BandPicker
                      id={`netcdfCubeRgb-${channel}`}
                      axis={axis}
                      value={rgbBands[index]}
                      onChange={(next) => setRgbBand(index, next)}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <p className="text-xs text-muted-foreground">
            {t("netcdfCube.planeEstimate", { count: planeCount })}
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={dismiss}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={draft.extent === "draw" && !draft.bbox}
            onClick={() =>
              startNetcdfCube({ ...draft, rgbBands: draft.rgbBands ? rgbBands : null })
            }
          >
            {t("netcdfCube.create")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One band of an axis, as a dropdown labelled with the axis' own coordinates
 * (wavelengths, for EMIT) or a plain number box for an axis too long to list.
 */
function BandPicker({
  axis,
  id,
  onChange,
  value,
}: {
  axis: LocalNetcdfAxis;
  id: string;
  onChange: (value: number) => void;
  value: number;
}) {
  if (!axis.values || axis.size > MAX_AXIS_OPTIONS) {
    return (
      <Input
        id={id}
        inputMode="numeric"
        value={String(value)}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) {
            onChange(Math.min(axis.size - 1, Math.max(0, Math.trunc(parsed))));
          }
        }}
      />
    );
  }
  return (
    <Select
      id={id}
      value={String(value)}
      onChange={(event) => onChange(Number(event.target.value))}
    >
      {axis.values.map((_, index) => (
        <option key={index} value={String(index)}>
          {bandLabel(axis, index)}
        </option>
      ))}
    </Select>
  );
}
