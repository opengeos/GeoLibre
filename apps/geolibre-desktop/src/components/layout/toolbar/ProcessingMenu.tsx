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
import { WHITEBOX_MENU_CATALOG } from "../../../lib/whitebox-menu-catalog";
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
  const setProcessingInitialTool = useAppStore(
    (s) => s.setProcessingInitialTool,
  );
  const setConversionOpen = useAppStore((s) => s.setConversionOpen);
  const setVectorToolOpen = useAppStore((s) => s.setVectorToolOpen);
  const setStatisticsToolOpen = useAppStore((s) => s.setStatisticsToolOpen);
  const setGeocodeOpen = useAppStore((s) => s.setGeocodeOpen);
  const setModelBuilderOpen = useAppStore((s) => s.setModelBuilderOpen);
  const setRasterToolOpen = useAppStore((s) => s.setRasterToolOpen);
  const setSegmentationOpen = useAppStore((s) => s.setSegmentationOpen);
  const setObjectDetectionOpen = useAppStore((s) => s.setObjectDetectionOpen);
  const setSegmentEverythingOpen = useAppStore(
    (s) => s.setSegmentEverythingOpen,
  );
  const setSqlWorkspaceOpen = useAppStore((s) => s.setSqlWorkspaceOpen);
  const setPythonConsoleOpen = useAppStore((s) => s.setPythonConsoleOpen);
  const setNotebookOpen = useAppStore((s) => s.setNotebookOpen);
  const setAssistantOpen = useAppStore((s) => s.setAssistantOpen);
  const setDashboardOpen = useAppStore((s) => s.setDashboardOpen);
  const setProcessingHistoryOpen = useAppStore(
    (s) => s.setProcessingHistoryOpen,
  );

  // Format Conversion, Raster tools, and AI Segmentation require the Python
  // sidecar, which cannot run on Android/iOS — hide them on mobile so they don't
  // present and then fail. Vector (Turf), SQL (PGlite/DuckDB), Python (Pyodide),
  // geocode, statistics, and the assistant run client-side and stay. The user
  // agent is stable for the session, so evaluate once.
  const mobile = useMemo(() => isMobile(), []);
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  const show = (id: string) => isMenuItemVisible(uiProfile, id);
  // The Whitebox toolbox (and its WASI/GeoLibre tool catalog) runs entirely in
  // the browser via WebAssembly, so unlike the sidecar-backed tools it stays
  // available on mobile.
  const showWhitebox = show("processing.whitebox");

  // Open the Whitebox toolbox dialog preselected to a specific tool, used by the
  // per-category submenus below. Two store writes: queue the tool, then open.
  const openWhiteboxTool = (toolId: string) => {
    setProcessingInitialTool(toolId);
    setProcessingOpen(true);
  };

  // Section visibility, so dividers never render with nothing on one side when a
  // UI profile (or mobile) hides whole sections. `showGeolibreTools` are the
  // client tool submenus; `showGeolibreActions` are geocode/model-builder/
  // segmentation below the in-submenu divider.
  const showGeolibreTools =
    (!mobile && show("processing.conversion")) ||
    show("processing.vector") ||
    show("processing.network") ||
    show("processing.statistics") ||
    (!mobile && show("processing.raster"));
  const showGeolibreActions =
    show("processing.geocode") ||
    show("processing.modelBuilder") ||
    (!mobile && show("processing.segmentation")) ||
    show("processing.objectDetection") ||
    show("processing.segmentEverything");
  const showGeolibre = showGeolibreTools || showGeolibreActions;
  const showWorkspacesOrServices =
    show("processing.history") ||
    show("processing.sqlWorkspace") ||
    show("processing.pythonConsole") ||
    show("processing.notebook") ||
    show("processing.dashboard") ||
    show("processing.planetaryComputer") ||
    show("processing.earthEngine");

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
        {showWhitebox && (
          <DropdownMenuItem onSelect={() => setProcessingOpen(true)}>
            {t("toolbar.item.whitebox")}
          </DropdownMenuItem>
        )}
        {/* Whitebox tools grouped by category/subcategory. Each leaf opens the
            Whitebox toolbox dialog preselected to that tool. Catalog data lives
            in lib/whitebox-menu-catalog.ts; gated with the Whitebox item, which
            runs in the browser via WebAssembly (so available on mobile too). */}
        {showWhitebox &&
          WHITEBOX_MENU_CATALOG.map((cat) => (
            <DropdownMenuSub key={cat.key}>
              <DropdownMenuSubTrigger>{t(cat.labelKey)}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {cat.subcategories.length === 1
                  ? cat.subcategories[0].tools.map((tool) => (
                      <DropdownMenuItem
                        key={tool.id}
                        onSelect={() => openWhiteboxTool(tool.id)}
                      >
                        {tool.name}
                      </DropdownMenuItem>
                    ))
                  : cat.subcategories.map((sub) => (
                      <DropdownMenuSub key={sub.label}>
                        <DropdownMenuSubTrigger>
                          {sub.label}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          {sub.tools.map((tool) => (
                            <DropdownMenuItem
                              key={tool.id}
                              onSelect={() => openWhiteboxTool(tool.id)}
                            >
                              {tool.name}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
        {/* GeoLibre's own tools (Turf vector, rasterio raster, format
            conversion, routing, spatial statistics) plus geocoding, batch &
            models, and AI segmentation. Grouped under a single "GeoLibre"
            submenu so their category names don't collide with the Whitebox
            category submenus above. Each child keeps its own visibility gate;
            the parent shows when any child does. */}
        {showGeolibre && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {t("toolbar.item.geolibre")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
        {!mobile && show("processing.conversion") && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {t("toolbar.item.conversion")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem
              onSelect={() => setConversionOpen("vector-to-vector")}
            >
              {t("toolbar.conversion.vectorToVector")}
            </DropdownMenuItem>
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
              onSelect={() => setConversionOpen("raster-to-pmtiles")}
            >
              {t("toolbar.conversion.rasterToPmtiles")}
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
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("toolbar.item.subGroupDataQuality")}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => setVectorToolOpen("check-validity")}
            >
              {t("toolbar.vectorTool.checkValidity")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setVectorToolOpen("fix-geometries")}
            >
              {t("toolbar.vectorTool.fixGeometries")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setVectorToolOpen("check-topology-rules")}
            >
              {t("toolbar.vectorTool.checkTopologyRules")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setVectorToolOpen("fix-topology")}
            >
              {t("toolbar.vectorTool.fixTopology")}
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
        {showGeolibreTools && showGeolibreActions && <DropdownMenuSeparator />}
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
        {!mobile && show("processing.segmentation") && (
          <DropdownMenuItem onSelect={() => setSegmentationOpen(true)}>
            {t("toolbar.command.segmentation")}
          </DropdownMenuItem>
        )}
        {/* Detection runs client-side (onnxruntime-web), not via the sidecar,
            so it stays available on mobile/web clients (no `!mobile` gate). */}
        {show("processing.objectDetection") && (
          <DropdownMenuItem onSelect={() => setObjectDetectionOpen(true)}>
            {t("toolbar.command.objectDetection")}
          </DropdownMenuItem>
        )}
        {/* SlimSAM "segment everything" also runs client-side (onnxruntime-web),
            so it stays available on mobile/web clients (no `!mobile` gate). */}
        {show("processing.segmentEverything") && (
          <DropdownMenuItem onSelect={() => setSegmentEverythingOpen(true)}>
            {t("toolbar.command.segmentEverything")}
          </DropdownMenuItem>
        )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        )}
        {/* Divide the tool-category submenus (Whitebox, GeoLibre) from the
            workspaces and consoles below. Only when both sides are present. */}
        {(showWhitebox || showGeolibre) &&
          showWorkspacesOrServices && <DropdownMenuSeparator />}
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
        {show("processing.history") && (
          <DropdownMenuItem onSelect={() => setProcessingHistoryOpen(true)}>
            {t("toolbar.item.processingHistory")}
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
