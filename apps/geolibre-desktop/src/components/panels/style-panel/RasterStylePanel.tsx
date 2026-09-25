import { DEFAULT_LAYER_STYLE, styleValue, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { Button, ScrollArea, Separator } from "@geolibre/ui";
import { RASTER_SOURCE_KIND, TIME_SLIDER_SOURCE_KIND } from "@geolibre/plugins";
import type { MapEngine } from "@geolibre/map";
import { PanelRightClose } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { NetcdfProfilePanel } from "../NetcdfProfilePanel";
import { RasterSymbologySection } from "../RasterSymbologySection";
import { TimeSliderSymbologySection } from "../TimeSliderSymbologySection";
import { STYLE_PANEL_ASIDE_CLASS } from "./constants";
import { RasterStyleSlider } from "./style-inputs";

interface RasterStylePanelProps {
  layer: GeoLibreLayer;
  resizeHandle: ReactNode;
  setIsCollapsed: (collapsed: boolean) => void;
  arcgisRasterEffectIgnored: boolean;
  beforeIdControl: ReactNode;
  zoomRangeControls: ReactNode;
  blendModeControl: ReactNode;
  isDeckRasterLayer: boolean;
  mapControllerRef: RefObject<MapEngine | null>;
}

/**
 * The Style panel for a raster layer: opacity, the MapLibre raster paint
 * sliders, and the raster / Time Slider / spectral-profile sections.
 *
 * @param props - The layer, the shared controls and the raster flags.
 * @returns The panel body.
 */
export function RasterStylePanel({
  layer,
  resizeHandle,
  setIsCollapsed,
  arcgisRasterEffectIgnored,
  beforeIdControl,
  zoomRangeControls,
  blendModeControl,
  isDeckRasterLayer,
  mapControllerRef,
}: RasterStylePanelProps) {
  const { t } = useTranslation();
  const setLayerOpacity = useAppStore((s) => s.setLayerOpacity);
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const { style } = layer;
  return (
    <aside aria-label={t("style.panelLabel")} className={STYLE_PANEL_ASIDE_CLASS}>
      {resizeHandle}
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="truncate text-sm font-semibold">
          {t("style.headingWithLayer", { name: layer.name })}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          title={t("style.collapse")}
          aria-label={t("style.collapse")}
          onClick={() => setIsCollapsed(true)}
        >
          <PanelRightClose className="h-4 w-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        {/* Padding on the inner content with extra right clearance so the
            overlay scrollbar never covers a control's right edge. */}
        <div className="space-y-4 p-3 pe-5">
          {arcgisRasterEffectIgnored && (
            <div
              className="text-xs text-amber-600"
              data-testid="style-arcgis-unsupported"
              role="note"
            >
              <p>{t("style.arcgisUnsupported.title")}</p>
              <ul className="list-disc ps-4">
                <li>{t("style.arcgisUnsupported.rasterEffectScene")}</li>
              </ul>
            </div>
          )}
          {beforeIdControl}
          {zoomRangeControls}
          <RasterStyleSlider
            label={t("style.raster.opacity")}
            value={layer.opacity}
            min={0}
            max={1}
            step={0.05}
            onChange={(value) => setLayerOpacity(layer.id, value)}
          />
          {blendModeControl}
          {!isDeckRasterLayer && (
            <>
              <RasterStyleSlider
                label={t("style.raster.brightnessMin")}
                value={styleValue(style, "rasterBrightnessMin")}
                min={0}
                max={1}
                step={0.05}
                onChange={(value) => setLayerStyle(layer.id, { rasterBrightnessMin: value })}
              />
              <RasterStyleSlider
                label={t("style.raster.brightnessMax")}
                value={styleValue(style, "rasterBrightnessMax")}
                min={0}
                max={1}
                step={0.05}
                onChange={(value) => setLayerStyle(layer.id, { rasterBrightnessMax: value })}
              />
              <RasterStyleSlider
                label={t("style.raster.saturation")}
                value={styleValue(style, "rasterSaturation")}
                min={-1}
                max={1}
                step={0.05}
                onChange={(value) => setLayerStyle(layer.id, { rasterSaturation: value })}
              />
              <Button
                type="button"
                size="sm"
                variant={styleValue(style, "rasterSaturation") <= -1 ? "default" : "outline"}
                className="w-full"
                aria-pressed={styleValue(style, "rasterSaturation") <= -1}
                title={t("style.raster.greyscaleHint")}
                onClick={() =>
                  setLayerStyle(layer.id, {
                    rasterSaturation:
                      styleValue(style, "rasterSaturation") <= -1
                        ? DEFAULT_LAYER_STYLE.rasterSaturation
                        : -1,
                  })
                }
              >
                {t("style.raster.greyscale")}
              </Button>
              <RasterStyleSlider
                label={t("style.raster.contrast")}
                value={styleValue(style, "rasterContrast")}
                min={-1}
                max={1}
                step={0.05}
                onChange={(value) => setLayerStyle(layer.id, { rasterContrast: value })}
              />
              <RasterStyleSlider
                label={t("style.raster.hueRotate")}
                value={styleValue(style, "rasterHueRotate")}
                min={0}
                max={360}
                step={1}
                onChange={(value) => setLayerStyle(layer.id, { rasterHueRotate: value })}
                format={(value) => value.toFixed(0)}
              />
            </>
          )}
          {layer.metadata.sourceKind === RASTER_SOURCE_KIND && (
            <RasterSymbologySection layer={layer} mapControllerRef={mapControllerRef} />
          )}
          {/* A Time Slider source is not in the raster plugin's registry, so
              the section above has nothing to attach to; its own spec fields
              are edited through the dock's control instead. */}
          {layer.metadata.sourceKind === TIME_SLIDER_SOURCE_KIND && (
            <TimeSliderSymbologySection layer={layer} />
          )}
          {/* The same section the NetCDF branch renders below: a multiband COG
              identified with the pixel inspector samples into the same store
              (see useCogSpectralIdentify), so its spectra need a home on the
              branch a raster layer actually lands on. The section renders null
              until this layer has a sampled pixel, so it costs nothing for the
              single-band and tile rasters that also come through here. */}
          <NetcdfProfilePanel layerId={layer.id} />
          <Separator />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full"
            title={t("style.raster.resetHint")}
            onClick={() => {
              setLayerOpacity(layer.id, 1);
              if (!isDeckRasterLayer) {
                setLayerStyle(layer.id, {
                  rasterBrightnessMin: DEFAULT_LAYER_STYLE.rasterBrightnessMin,
                  rasterBrightnessMax: DEFAULT_LAYER_STYLE.rasterBrightnessMax,
                  rasterSaturation: DEFAULT_LAYER_STYLE.rasterSaturation,
                  rasterContrast: DEFAULT_LAYER_STYLE.rasterContrast,
                  rasterHueRotate: DEFAULT_LAYER_STYLE.rasterHueRotate,
                });
              }
            }}
          >
            {t("style.raster.reset")}
          </Button>
        </div>
      </ScrollArea>
      <Separator />
      <p className="p-2 text-[10px] text-muted-foreground">
        {isDeckRasterLayer ? t("style.raster.footerDeck") : t("style.raster.footerMaplibre")}
      </p>
    </aside>
  );
}
