import { isCesiumKmlLayer, type GeoLibreLayer } from "@geolibre/core";
import { Button, ScrollArea, Separator } from "@geolibre/ui";
import type { MapEngine } from "@geolibre/map";
import { PanelRightClose } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { getNetcdfLayerState, NETCDF_IMAGE_SOURCE_KIND } from "../../../lib/netcdf-image-symbology";
import { NetcdfProfilePanel } from "../NetcdfProfilePanel";
import { NetcdfSymbologySection } from "../NetcdfSymbologySection";
import { QuickFiltersSection } from "../QuickFiltersSection";
import { STYLE_PANEL_ASIDE_CLASS } from "./constants";

interface NoPaintControlsStylePanelProps {
  layer: GeoLibreLayer;
  resizeHandle: ReactNode;
  setIsCollapsed: (collapsed: boolean) => void;
  beforeIdControl: ReactNode;
  blendModeControl: ReactNode;
  hasTilesetSymbology: boolean;
  vectorSymbologyControls: ReactNode;
  /**
   * The shared Expression Builder dialog (null while closed). The tileset
   * symbology's builder buttons open it, so it must be drawn here as well as
   * in the full vector panel.
   */
  expressionBuilderDialog: ReactNode;
  hasQuickFilterControls: boolean;
  isNativeDocumentScene: boolean;
  mapControllerRef: RefObject<MapEngine | null>;
  mapReadyGeneration?: number;
}

/**
 * The Style panel for a layer with no MapLibre paint controls: NetCDF grids,
 * 3D tilesets (tileset symbology), and everything else that only offers
 * ordering and filtering.
 *
 * @param props - The layer, the shared controls and the capability flags.
 * @returns The panel body.
 */
export function NoPaintControlsStylePanel({
  layer,
  resizeHandle,
  setIsCollapsed,
  beforeIdControl,
  blendModeControl,
  hasTilesetSymbology,
  vectorSymbologyControls,
  expressionBuilderDialog,
  hasQuickFilterControls,
  isNativeDocumentScene,
  mapControllerRef,
  mapReadyGeneration,
}: NoPaintControlsStylePanelProps) {
  const { t } = useTranslation();
  // The section renders nothing without retained grids, so ask here too, or
  // the panel would suppress the fallback message and show an empty body.
  // The layer state rather than `getNetcdfImageSource`, which is null for an
  // RGB composite: that one has no colormap to re-apply, but it does have a
  // band summary to show and pixels to sample.
  const hasNetcdfSymbology =
    layer.metadata.sourceKind === NETCDF_IMAGE_SOURCE_KIND &&
    getNetcdfLayerState(layer.id) !== null;
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
          {blendModeControl}
          {/* A NetCDF grid baked to pixels has no MapLibre paint properties,
              so it lands in this branch; its colormap/limits are re-applied
              by re-baking the image rather than by a style property. The
              grids are dropped on a project reload, so the generic message
              still has to appear for a layer restored from one. */}
          {hasNetcdfSymbology ? (
            <NetcdfSymbologySection layer={layer} />
          ) : hasTilesetSymbology ? (
            // A tileset has no MapLibre paint properties, but the globe can
            // classify its features from the same symbology every vector
            // layer uses — `CesiumLayerSync` compiles the colour expression
            // and the layer filter into a `Cesium3DTileStyle` (#2290). The
            // attribute list comes from `metadata.fields`, which the globe
            // fills in from the first rendered tile, so it appears once the
            // tileset has drawn rather than while it is still loading.
            <>
              <p className="text-xs text-muted-foreground">{t("style.tilesetSymbology")}</p>
              {vectorSymbologyControls}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t("style.noControls")}</p>
          )}
          {hasNetcdfSymbology && <NetcdfProfilePanel layerId={layer.id} />}
          {/* A layer with no paint controls of its own (a plugin owns its
              paint, or a control paints it) can still be filtered, so the
              Quick filters section is offered here too rather than only in
              the full vector panel below. */}
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
        {t("style.selectedLayerType", {
          type: isCesiumKmlLayer(layer) ? "KML / KMZ" : isNativeDocumentScene ? "czml" : layer.type,
        })}
      </p>
      {expressionBuilderDialog}
    </aside>
  );
}
