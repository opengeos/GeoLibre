import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  DEFAULT_RENDER_RAMP,
  RENDER_RAMPS,
  renderTileUrl,
  specFromTileUrl,
  withRenderStyle,
  type RenderRamp,
  type RenderStyle,
} from "@geolibre/plugins";
import { Button, Input, Label, Select, Separator } from "@geolibre/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RasterStyleSlider } from "./style-inputs";

/** How long edits settle before the tiles are asked for again. */
const APPLY_DELAY_MS = 250;
/** The most a window end may be, as far as a recipe will hold. */
const MAX_WINDOW_VALUE = 1e6;

interface StacRenderingSectionProps {
  layer: GeoLibreLayer;
}

/** The first tile template a rendering layer was added with. */
function tileTemplate(layer: GeoLibreLayer): string | undefined {
  const tiles = layer.source.tiles;
  if (Array.isArray(tiles) && typeof tiles[0] === "string") return tiles[0];
  return typeof layer.source.url === "string" ? layer.source.url : undefined;
}

/**
 * The raster style of a STAC band combination or index: how bright and how contrasty a colour
 * composite is, and which ramp and value window an index is drawn on. The recipe lives in the
 * layer's tile URL, so an edit rewrites that URL and saves with the project; layer sync hands the
 * new URL to the map's source, so the tiles reload at once, and an undo does the same in reverse.
 *
 * @param props - The rendering layer.
 * @returns The section, or null when the layer is not one of our renderings.
 */
export function StacRenderingSection({ layer }: StacRenderingSectionProps) {
  const { t } = useTranslation();
  const updateLayer = useAppStore((s) => s.updateLayer);
  const template = tileTemplate(layer);
  const spec = useMemo(() => (template ? specFromTileUrl(template) : null), [template]);
  const [style, setStyle] = useState<RenderStyle>(spec?.style ?? {});
  // Number boxes hold what is typed until it is a usable number.
  const [minText, setMinText] = useState(String(spec?.style?.min ?? -1));
  const [maxText, setMaxText] = useState(String(spec?.style?.max ?? 1));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Whether an edit is waiting to be written, so the controls are not reset from under it. */
  const pending = useRef(false);

  const layerId = layer.id;
  /** Loads the controls from the style the layer's recipe holds. */
  const readStyle = (): void => {
    setStyle(spec?.style ?? {});
    setMinText(String(spec?.style?.min ?? -1));
    setMaxText(String(spec?.style?.max ?? 1));
  };
  // Another layer starts from its own saved style.
  useEffect(() => {
    readStyle();
    // Re-read only when the layer changes.
  }, [layerId]); // eslint-disable-line react-hooks/exhaustive-deps
  // So does the same layer when its recipe changes outside this panel (an undo, a redo): the
  // controls follow it, unless an edit of their own is still waiting to be written.
  useEffect(() => {
    if (!pending.current) readStyle();
  }, [template]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!spec) return null;

  /** Shows an edit at once and writes it to the layer once edits settle. */
  const apply = (next: RenderStyle): void => {
    setStyle(next);
    clearTimeout(timer.current);
    pending.current = true;
    // Written to the layer as it is when the timer fires, found by id: another edit (a rename, an
    // undo) or another layer being selected in the meantime must not be written over or lose this
    // one. Closing the panel does not cancel it either.
    const targetId = layerId;
    timer.current = setTimeout(() => {
      pending.current = false;
      const current = useAppStore.getState().layers.find((entry) => entry.id === targetId);
      const currentTemplate = current ? tileTemplate(current) : undefined;
      const currentSpec = currentTemplate ? specFromTileUrl(currentTemplate) : null;
      if (!current || !currentSpec) return;
      const url = renderTileUrl(withRenderStyle(currentSpec, next));
      if (url === currentTemplate) return;
      // Layer sync notices the new template and hands it to the map's source.
      updateLayer(targetId, { source: { ...current.source, tiles: [url], url } });
    }, APPLY_DELAY_MS);
  };

  /** Applies the typed value window, or puts back the one in force when it is not usable. */
  const commitWindow = (): void => {
    const min = Number(minText);
    const max = Number(maxText);
    // A window needs two numbers, the low one first, that a recipe is allowed to hold; anything
    // else reverts to what applies.
    if (
      minText.trim() === "" ||
      maxText.trim() === "" ||
      !(min < max) ||
      Math.abs(min) > MAX_WINDOW_VALUE ||
      Math.abs(max) > MAX_WINDOW_VALUE
    ) {
      setMinText(String(style.min ?? -1));
      setMaxText(String(style.max ?? 1));
      return;
    }
    apply({ ...style, min, max });
  };

  /** Goes back to the default style. */
  const reset = (): void => {
    setMinText("-1");
    setMaxText("1");
    apply({});
  };

  return (
    <div className="space-y-3" data-testid="stac-rendering-style">
      <Separator />
      <div className="text-xs font-semibold">{t("style.raster.stacRendering.title")}</div>
      {spec.kind === "rgb" ? (
        <>
          <RasterStyleSlider
            label={t("style.raster.stacRendering.brightness")}
            value={style.gain ?? 1}
            min={0.3}
            max={3}
            step={0.05}
            onChange={(gain) => apply({ ...style, gain })}
          />
          <RasterStyleSlider
            label={t("style.raster.stacRendering.gamma")}
            value={style.gamma ?? 1}
            min={0.3}
            max={3}
            step={0.05}
            onChange={(gamma) => apply({ ...style, gamma })}
          />
        </>
      ) : (
        <>
          <div className="space-y-1">
            <Label htmlFor="stacRenderingRamp">{t("style.raster.stacRendering.ramp")}</Label>
            <Select
              id="stacRenderingRamp"
              value={style.ramp ?? DEFAULT_RENDER_RAMP}
              onChange={(event) => apply({ ...style, ramp: event.target.value as RenderRamp })}
            >
              {(Object.keys(RENDER_RAMPS) as RenderRamp[]).map((ramp) => (
                <option key={ramp} value={ramp}>
                  {ramp}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor="stacRenderingMin">{t("style.raster.stacRendering.min")}</Label>
              <Input
                id="stacRenderingMin"
                type="number"
                inputMode="decimal"
                step={0.1}
                className="h-7 text-xs"
                value={minText}
                onChange={(event) => setMinText(event.target.value)}
                onBlur={commitWindow}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor="stacRenderingMax">{t("style.raster.stacRendering.max")}</Label>
              <Input
                id="stacRenderingMax"
                type="number"
                inputMode="decimal"
                step={0.1}
                className="h-7 text-xs"
                value={maxText}
                onChange={(event) => setMaxText(event.target.value)}
                onBlur={commitWindow}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </div>
          </div>
        </>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-full"
        title={t("style.raster.stacRendering.resetHint")}
        onClick={reset}
      >
        {t("style.raster.stacRendering.reset")}
      </Button>
    </div>
  );
}
