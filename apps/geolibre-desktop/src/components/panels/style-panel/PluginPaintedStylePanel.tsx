import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { Button, ScrollArea, Separator } from "@geolibre/ui";
import type { MapEngine } from "@geolibre/map";
import { PanelRightClose } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { QuickFiltersSection } from "../QuickFiltersSection";
import { STYLE_PANEL_ASIDE_CLASS } from "./constants";
import { RasterStyleSlider } from "./style-inputs";

interface PluginPaintedStylePanelProps {
  layer: GeoLibreLayer;
  resizeHandle: ReactNode;
  setIsCollapsed: (collapsed: boolean) => void;
  beforeIdControl: ReactNode;
  zoomRangeControls: ReactNode;
  hasBridgedOpacity: boolean;
  isServiceStyledLayer: boolean;
  hasQuickFilterControls: boolean;
  mapControllerRef: RefObject<MapEngine | null>;
  mapReadyGeneration?: number;
}

/**
 * The Style panel for a layer whose paint a plugin (or an ArcGIS service
 * style) owns.
 *
 * @param props - The layer, the shared controls and the capability flags.
 * @returns The panel body.
 */
export function PluginPaintedStylePanel({
  layer,
  resizeHandle,
  setIsCollapsed,
  beforeIdControl,
  zoomRangeControls,
  hasBridgedOpacity,
  isServiceStyledLayer,
  hasQuickFilterControls,
  mapControllerRef,
  mapReadyGeneration,
}: PluginPaintedStylePanelProps) {
  const { t } = useTranslation();
  const setLayerOpacity = useAppStore((s) => s.setLayerOpacity);
  // The plugin paints this layer itself, so the panel keeps only the controls
  // that still reach it: insert-below and the zoom range (MapLibre honors both
  // on a custom layer) plus Opacity when the registration bridged setOpacity.
  // Everything else is styled from the plugin's own panel. A service-styled
  // ArcGIS layer lands here too; its opacity is a native paint property, so
  // the slider always reaches it.
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
        <div className="space-y-4 p-3 pe-5">
          {beforeIdControl}
          {zoomRangeControls}
          {(hasBridgedOpacity || isServiceStyledLayer) && (
            <RasterStyleSlider
              label={t("style.raster.opacity")}
              value={layer.opacity}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => setLayerOpacity(layer.id, value)}
            />
          )}
          {/* Filtering is independent of who owns the paint: layer sync
              narrows a plugin-painted layer's native layers just like any
              other, so the section belongs here too. */}
          {hasQuickFilterControls ? (
            <>
              <Separator />
              <QuickFiltersSection
                key={`qf-${layer.id}`}
                layer={layer}
                mapControllerRef={mapControllerRef}
                mapReadyGeneration={mapReadyGeneration}
              />
            </>
          ) : null}
        </div>
      </ScrollArea>
      <Separator />
      <p className="p-2 text-[10px] text-muted-foreground">
        {t(isServiceStyledLayer ? "style.serviceStyledFooter" : "style.pluginPaintedFooter")}
      </p>
    </aside>
  );
}
