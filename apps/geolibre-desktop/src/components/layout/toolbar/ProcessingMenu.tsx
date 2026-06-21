import { type NetworkToolKind, useAppStore } from "@geolibre/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import { Wrench } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ToolbarPanel } from "../../../hooks/useToolbarPanels";
import { isMobile } from "../../../lib/is-mobile";
import { useDesktopSettingsStore } from "../../../hooks/useDesktopSettings";
import { isMenuItemVisible } from "../../../lib/ui-profile";
import type { ToolbarChrome } from "./constants";

interface ProcessingMenuProps {
  chrome: ToolbarChrome;
  earthEnginePanel: ToolbarPanel;
  onOpenNetworkTool: (kind: NetworkToolKind) => void;
  onOpenPlanetaryComputer: () => void;
  onOpenGeoreferencer: () => void;
}

/** The Processing menu: assistant, toolboxes, conversion/vector/network/statistics/raster submenus. */
export function ProcessingMenu({
  chrome,
  earthEnginePanel,
  onOpenNetworkTool,
  onOpenPlanetaryComputer,
  onOpenGeoreferencer,
}: ProcessingMenuProps) {
  const { t } = useTranslation();
  const setProcessingOpen = useAppStore((s) => s.setProcessingOpen);
  const setConversionOpen = useAppStore((s) => s.setConversionOpen);
  const setVectorToolOpen = useAppStore((s) => s.setVectorToolOpen);
  const setStatisticsToolOpen = useAppStore((s) => s.setStatisticsToolOpen);
  const setGeocodeOpen = useAppStore((s) => s.setGeocodeOpen);
  const setModelBuilderOpen = useAppStore((s) => s.setModelBuilderOpen);
  const setRasterToolOpen = useAppStore((s) => s.setRasterToolOpen);
  const setSegmentationOpen = useAppStore((s) => s.setSegmentationOpen);
  const setSqlWorkspaceOpen = useAppStore((s) => s.setSqlWorkspaceOpen);
  const setPythonConsoleOpen = useAppStore((s) => s.setPythonConsoleOpen);
  const setNotebookOpen = useAppStore((s) => s.setNotebookOpen);
  const setAssistantOpen = useAppStore((s) => s.setAssistantOpen);
  const setDashboardOpen = useAppStore((s) => s.setDashboardOpen);

  // Whitebox, format Conversion, Raster tools, and AI Segmentation all require
  // the Python sidecar, which cannot run on Android/iOS — hide them on mobile so
  // they don't present and then fail. Vector (Turf), SQL (PGlite/DuckDB), Python
  // (Pyodide), geocode, statistics, and the assistant run client-side and stay.
  // The user agent is stable for the session, so evaluate once.
  const mobile = useMemo(() => isMobile(), []);
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  const show = (id: string) => isMenuItemVisible(uiProfile, id);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={chrome.buttonClass}
          variant="ghost"
          size={chrome.buttonSize}
          aria-label={t("toolbar.menu.processing")}
        >
          <Wrench className={chrome.iconClassName} />
          {chrome.renderLabel(t("toolbar.menu.processing"))}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("toolbar.menu.processing")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {show("processing.assistant") && (
          <>
            <DropdownMenuItem onSelect={() => setAssistantOpen(true)}>
              {t("toolbar.command.assistant")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {!mobile && show("processing.whitebox") && (
          <DropdownMenuItem onSelect={() => setProcessingOpen(true)}>
            {t("toolbar.item.whitebox")}
          </DropdownMenuItem>
        )}
        {show("processing.sqlWorkspace") && (
          <DropdownMenuItem onSelect={() => setSqlWorkspaceOpen(true)}>
            {t("toolbar.command.sqlWorkspace")}
          </DropdownMenuItem>
        )}
        {show("processing.pythonConsole") && (
          <DropdownMenuItem onSelect={() => setPythonConsoleOpen(true)}>
            {t("toolbar.command.pythonConsole")}
          </DropdownMenuItem>
        )}
        {show("processing.notebook") && (
          <DropdownMenuItem onSelect={() => setNotebookOpen(true)}>
            {t("toolbar.command.notebook")}
          </DropdownMenuItem>
        )}
        {show("processing.dashboard") && (
          <DropdownMenuItem onSelect={() => setDashboardOpen(true)}>
            {t("toolbar.command.dashboard")}
          </DropdownMenuItem>
        )}
        {show("processing.geocode") && (
          <DropdownMenuItem onSelect={() => setGeocodeOpen(true)}>
            {t("toolbar.item.geocode")}
          </DropdownMenuItem>
        )}
        {show("processing.modelBuilder") && (
          <DropdownMenuItem onSelect={() => setModelBuilderOpen(true)}>
            {t("toolbar.item.modelBuilder")}
          </DropdownMenuItem>
        )}
        {!mobile && show("processing.conversion") && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {t("toolbar.item.conversion")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem
              onSelect={() => setConversionOpen("vector-to-geoparquet")}
            >
              {t("toolbar.conversion.vectorToGeoparquet")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setConversionOpen("vector-to-flatgeobuf")}
            >
              {t("toolbar.conversion.vectorToFlatgeobuf")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setConversionOpen("vector-to-shapefile")}
            >
              {t("toolbar.conversion.vectorToShapefile")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setConversionOpen("vector-to-geopackage")}
            >
              {t("toolbar.conversion.vectorToGeopackage")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setConversionOpen("csv-to-geoparquet")}
            >
              {t("toolbar.conversion.csvToGeoparquet")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setConversionOpen("vector-to-pmtiles")}
            >
              {t("toolbar.conversion.vectorToPmtiles")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setConversionOpen("raster-to-cog")}
            >
              {t("toolbar.conversion.rasterToCog")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        )}
        {show("processing.vector") && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {t("toolbar.item.vector")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("toolbar.item.subGroupGeometry")}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setVectorToolOpen("buffer")}>
              {t("toolbar.vectorTool.buffer")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setVectorToolOpen("centroids")}>
              {t("toolbar.vectorTool.centroids")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setVectorToolOpen("convex-hull")}>
              {t("toolbar.vectorTool.convexHull")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setVectorToolOpen("dissolve")}>
              {t("toolbar.vectorTool.dissolve")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setVectorToolOpen("bounding-box")}
            >
              {t("toolbar.vectorTool.boundingBox")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setVectorToolOpen("simplify")}>
              {t("toolbar.vectorTool.simplify")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setVectorToolOpen("reproject")}>
              {t("toolbar.vectorTool.reproject")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setVectorToolOpen("explode")}>
              {t("toolbar.vectorTool.explode")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setVectorToolOpen("aggregate")}>
              {t("toolbar.vectorTool.aggregate")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setVectorToolOpen("smooth")}>
              {t("toolbar.vectorTool.smooth")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setVectorToolOpen("grid")}>
              {t("toolbar.vectorTool.grid")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setVectorToolOpen("voronoi")}>
              {t("toolbar.vectorTool.voronoi")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setVectorToolOpen("cell-sectors")}
            >
              {t("toolbar.vectorTool.cellSectors")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("toolbar.item.subGroupOverlay")}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setVectorToolOpen("clip")}>
              {t("toolbar.vectorTool.clip")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setVectorToolOpen("intersection")}>
              {t("toolbar.vectorTool.intersection")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setVectorToolOpen("difference")}>
              {t("toolbar.vectorTool.difference")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setVectorToolOpen("union")}>
              {t("toolbar.vectorTool.union")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("toolbar.item.subGroupJoin")}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setVectorToolOpen("spatial-join")}>
              {t("toolbar.vectorTool.spatialJoin")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setVectorToolOpen("attribute-join")}
            >
              {t("toolbar.vectorTool.attributeJoin")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("toolbar.item.subGroupSelect")}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => setVectorToolOpen("select-by-value")}
            >
              {t("toolbar.vectorTool.selectByValue")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setVectorToolOpen("select-by-location")}
            >
              {t("toolbar.vectorTool.selectByLocation")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("toolbar.item.subGroupH3")}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setVectorToolOpen("h3-grid")}>
              {t("toolbar.vectorTool.h3Grid")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setVectorToolOpen("h3-bin-points")}
            >
              {t("toolbar.vectorTool.h3BinPoints")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("toolbar.item.subGroupMovement")}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => setVectorToolOpen("trajectory-speed")}
            >
              {t("toolbar.vectorTool.trajectorySpeed")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setVectorToolOpen("detect-stops")}
            >
              {t("toolbar.vectorTool.detectStops")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setVectorToolOpen("space-time-proximity")}
            >
              {t("toolbar.vectorTool.spaceTimeProximity")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        )}
        {show("processing.network") && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {t("toolbar.item.network")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onSelect={() => onOpenNetworkTool("isochrone")}>
              {t("toolbar.networkTool.isochrone")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenNetworkTool("od-matrix")}>
              {t("toolbar.networkTool.odMatrix")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onOpenNetworkTool("sequential-route")}
            >
              {t("toolbar.networkTool.sequentialRoute")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        )}
        {show("processing.statistics") && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {t("toolbar.item.statistics")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem
              onSelect={() => setStatisticsToolOpen("global-morans-i")}
            >
              {t("toolbar.statisticsTool.globalMoransI")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setStatisticsToolOpen("local-morans-i")}
            >
              {t("toolbar.statisticsTool.localMoransI")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setStatisticsToolOpen("getis-ord-gi")}
            >
              {t("toolbar.statisticsTool.getisOrd")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                setStatisticsToolOpen("average-nearest-neighbor")
              }
            >
              {t("toolbar.statisticsTool.averageNearestNeighbor")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setStatisticsToolOpen("kernel-density")}
            >
              {t("toolbar.statisticsTool.kernelDensity")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        )}
        {!mobile && show("processing.raster") && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {t("toolbar.item.raster")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("toolbar.item.subGroupTerrain")}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setRasterToolOpen("hillshade")}>
              {t("toolbar.rasterTool.hillshade")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRasterToolOpen("slope")}>
              {t("toolbar.rasterTool.slope")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRasterToolOpen("aspect")}>
              {t("toolbar.rasterTool.aspect")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("toolbar.item.subGroupReproject")}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setRasterToolOpen("reproject")}>
              {t("toolbar.rasterTool.reproject")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRasterToolOpen("resample")}>
              {t("toolbar.rasterTool.resample")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("toolbar.item.subGroupClip")}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setRasterToolOpen("clip-extent")}>
              {t("toolbar.rasterTool.clipExtent")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRasterToolOpen("clip-mask")}>
              {t("toolbar.rasterTool.clipMask")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("toolbar.item.subGroupRasterToVector")}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setRasterToolOpen("polygonize")}>
              {t("toolbar.rasterTool.polygonize")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRasterToolOpen("contour")}>
              {t("toolbar.rasterTool.contour")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("toolbar.item.subGroupVectorToRaster")}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setRasterToolOpen("interpolate")}>
              {t("toolbar.rasterTool.interpolate")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("toolbar.item.subGroupAnalysis")}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setRasterToolOpen("zonal")}>
              {t("toolbar.rasterTool.zonal")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRasterToolOpen("raster-calc")}>
              {t("toolbar.rasterTool.rasterCalc")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRasterToolOpen("spectral-index")}>
              {t("toolbar.rasterTool.spectralIndex")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRasterToolOpen("reclassify")}>
              {t("toolbar.rasterTool.reclassify")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRasterToolOpen("mosaic")}>
              {t("toolbar.rasterTool.mosaic")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRasterToolOpen("focal")}>
              {t("toolbar.rasterTool.focal")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onOpenGeoreferencer}>
              {t("toolbar.item.georeferencing")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        )}
        {!mobile && show("processing.segmentation") && (
          <DropdownMenuItem onSelect={() => setSegmentationOpen(true)}>
            {t("toolbar.command.segmentation")}
          </DropdownMenuItem>
        )}
        {show("processing.planetaryComputer") && (
          <DropdownMenuItem onSelect={onOpenPlanetaryComputer}>
            {t("toolbar.command.planetaryComputer")}
          </DropdownMenuItem>
        )}
        {show("processing.earthEngine") && (
          <DropdownMenuItem onSelect={earthEnginePanel.toggle}>
            {t("toolbar.command.earthEngine")}
            {earthEnginePanel.visible ? " ✓" : ""}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
