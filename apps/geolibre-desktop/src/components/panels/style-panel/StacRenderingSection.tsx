import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { sourceId, type MapEngine } from "@geolibre/map";
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
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { RasterStyleSlider } from "./style-inputs";

/** How long edits settle before the tiles are asked for again. */
const APPLY_DELAY_MS = 250;

interface StacRenderingSectionProps {
  layer: GeoLibreLayer;
  mapControllerRef: RefObject<MapEngine | null>;
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
 * layer's tile URL, so an edit rewrites that URL, saves with the project, and is pushed to the
 * map's source so the tiles reload at once.
 *
 * @param props - The rendering layer and the map controller.
 * @returns The section, or null when the layer is not one of our renderings.
 */
export function StacRenderingSection({ layer, mapControllerRef }: StacRenderingSectionProps) {
  const { t } = useTranslation();
  const updateLayer = useAppStore((s) => s.updateLayer);
  const template = tileTemplate(layer);
  const spec = useMemo(() => (template ? specFromTileUrl(template) : null), [template]);
  const [style, setStyle] = useState<RenderStyle>(spec?.style ?? {});
  // Number boxes hold what is typed until it is a usable number.
  const [minText, setMinText] = useState(String(spec?.style?.min ?? -1));
  const [maxText, setMaxText] = useState(String(spec?.style?.max ?? 1));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const appliedUrl = useRef(template);

  // A different layer (or one undone elsewhere) starts from its own saved style.
  const layerId = layer.id;
  useEffect(() => {
    setStyle(spec?.style ?? {});
    setMinText(String(spec?.style?.min ?? -1));
    setMaxText(String(spec?.style?.max ?? 1));
    appliedUrl.current = template;
    // Re-read only when the layer changes; our own edits update `template` through the store.
  }, [layerId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!spec) return null;

  const apply = (next: RenderStyle): void => {
    setStyle(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const url = renderTileUrl(withRenderStyle(spec, next));
      if (url === appliedUrl.current) return;
      appliedUrl.current = url;
      updateLayer(layer.id, { source: { ...layer.source, tiles: [url], url } });
      // Layer sync adds a raster source once and leaves it, so the new tiles go in directly.
      const source = mapControllerRef.current?.getMap()?.getSource(sourceId(layer.id)) as
        | { setTiles?: (tiles: string[]) => void }
        | undefined;
      source?.setTiles?.([url]);
    }, APPLY_DELAY_MS);
  };

  const commitWindow = (): void => {
    const min = Number(minText);
    const max = Number(maxText);
    // A window needs two numbers with the low one first; anything else reverts to what applies.
    if (minText.trim() === "" || maxText.trim() === "" || !(min < max)) {
      setMinText(String(style.min ?? -1));
      setMaxText(String(style.max ?? 1));
      return;
    }
    apply({ ...style, min, max });
  };

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
