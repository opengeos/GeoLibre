import { useAppStore } from "@geolibre/core";
import { rendererCapabilities, type MapEngine } from "@geolibre/map";
import {
  CLOUDS_PLUGIN_ID,
  DIRECTIONS_PLUGIN_ID,
  EFFECTS_PLUGIN_ID,
  GRATICULE_PLUGIN_ID,
  LAYER_CONTROL_PLUGIN_ID,
  openPlanetaryComputerPanel,
  PRECIPITATION_PLUGIN_ID,
  REVERSE_GEOCODE_PLUGIN_ID,
} from "@geolibre/plugins";
import { Button, cn } from "@geolibre/ui";
import { Map, Moon, Sun } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConsentGatedActions } from "../../hooks/useConsentGatedActions";
import type { CollaborationApi } from "../../hooks/useCollaboration";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import { useMapCapabilities } from "../../hooks/useMapCapabilities";
import { useOsmPbfLoader } from "../../hooks/useOsmPbfLoader";
import { createAppAPI, usePluginRegistry } from "../../hooks/usePlugins";
import { useTilePackageLoader } from "../../hooks/useTilePackageLoader";
import type { ProjectFileActions } from "../../hooks/useProjectFileActions";
import type { ThemeMode } from "../../hooks/useThemeMode";
import { useToolbarPanels } from "../../hooks/useToolbarPanels";
import { useVectorTileGeometryBackfill } from "../../hooks/useVectorTileGeometryBackfill";
import { useViewportHistory } from "../../hooks/useViewportHistory";
import { useAddDataDialogState } from "../../hooks/toolbar/useAddDataDialogState";
import { useMapControlVisibility } from "../../hooks/toolbar/useMapControlVisibility";
import { usePluginLabelSync } from "../../hooks/toolbar/usePluginLabelSync";
import { usePaletteCommands } from "../../hooks/toolbar/usePaletteCommands";
import { openSimplifyInterface, useToolbarCommands } from "../../hooks/toolbar/useToolbarCommands";
import { useToolbarDialogs } from "../../hooks/toolbar/useToolbarDialogs";
import { resolveAppName } from "../../lib/app-name";
import { IS_MAS_BUILD } from "../../lib/build-flags";
import { googleEarthUrl, googleMapsUrl } from "../../lib/external-map-links";
import { isMobile } from "../../lib/is-mobile";
import { resolveShareHost } from "../../lib/share-geolibre";
import { isTauri } from "../../lib/tauri-io";
import { MENU_MANAGED_PLUGIN_IDS, isMenuVisible, isPluginVisible } from "../../lib/ui-profile";
import { GcsExportDialog } from "./GcsExportDialog";
import { SettingsDialog } from "./SettingsDialog";
import type { MobileNavTabId } from "./mobile/MobileBottomNav";
import { MobileToolbarChrome } from "./mobile/MobileToolbarChrome";
import { AddDataMenu } from "./toolbar/AddDataMenu";
import { openExternalLink, type ToolbarChrome } from "./toolbar/constants";
import { ControlsMenu } from "./toolbar/ControlsMenu";
import { EditMenu } from "./toolbar/EditMenu";
import { HelpMenu } from "./toolbar/HelpMenu";
import { ImageControlDialog } from "./toolbar/ImageControlDialog";
import { PluginsMenu } from "./toolbar/PluginsMenu";
import { PluginToolbarMenus } from "./toolbar/PluginToolbarMenus";
import { ProcessingMenu } from "./toolbar/ProcessingMenu";
import { ProjectMenu } from "./toolbar/ProjectMenu";
import { ProjectNameField } from "./toolbar/ProjectNameField";
import { ToolbarDialogsHost } from "./toolbar/ToolbarDialogsHost";
import { entryMenuOffered } from "../../lib/deployment-gates";
import {
  createAddLayerHandlers,
  resetRuntimeControlsForNewProject,
} from "./toolbar/toolbar-actions";
import { ViewMenu } from "./toolbar/ViewMenu";
import { handleMenubarKeyDown } from "./toolbar/menubarKeyboard";

interface TopToolbarProps {
  compact?: boolean;
  diagnosticsErrorCount: number;
  mapControllerRef: React.RefObject<MapEngine | null>;
  mapReadyGeneration: number;
  showLabels?: boolean;
  showProjectInfo?: boolean;
  themeMode: ThemeMode;
  // Lifted to DesktopShell so the on-canvas status badge can share one live
  // session (calling useCollaboration twice would open two sockets).
  collaboration: CollaborationApi;
  // Lifted to DesktopShell so the toolbar and the Browser panel share one
  // instance — two would not coordinate their in-flight "open recent" aborts.
  projectFiles: ProjectFileActions;
  onOpenDiagnostics: () => void;
  onOpenProjectHistory: () => void;
  onToggleThemeMode: () => void;
  // Opens the Offline Basemap Extract panel, mounted in DesktopShell over the
  // map so it can stay non-modal (the map is interactive for drawing a bbox).
  onOpenBasemapExtract: () => void;
  /** Activates the map tool for placing an anchored review comment. */
  onAddComment: () => void;
  viewer?: boolean;
  /** Render compact MobileTopBar + mobile quick sheets instead of the desktop menubar. */
  mobileShell?: boolean;
  /** Currently selected tab in the phone mobile bottom navigation bar. */
  activeMobileTab?: MobileNavTabId | null;
  /** Switch or close the active phone mobile bottom navigation tab. */
  onSelectMobileTab?: (tab: MobileNavTabId | null) => void;
  /** Workspace container element where mobile quick sheets portal above the bottom nav. */
  mobileSheetHostEl?: HTMLDivElement | null;
}

export function TopToolbar({
  compact = false,
  diagnosticsErrorCount,
  mapControllerRef,
  mapReadyGeneration,
  showLabels = true,
  showProjectInfo = true,
  themeMode,
  collaboration,
  projectFiles,
  onOpenDiagnostics,
  onOpenProjectHistory,
  onToggleThemeMode,
  onOpenBasemapExtract,
  onAddComment,
  viewer = false,
  mobileShell = false,
  activeMobileTab = null,
  onSelectMobileTab,
  mobileSheetHostEl = null,
}: TopToolbarProps) {
  const { t } = useTranslation();
  const [gcsExportOpen, setGcsExportOpen] = useState(false);
  const deploymentCapabilities = useAppStore((state) => state.deploymentCapabilities);
  usePluginLabelSync();

  // The globe owns the primary map, so the MapLibre-only entries below are dead
  // while it is active and the View menu becomes the only way back to 2D (#2217).
  const primaryRenderer = useAppStore((s) => s.primaryRenderer);
  // Mapbox publishes its engine only after the initial style loads, and the
  // ArcGIS engine once its view is ready. Before that, plugin panels cannot
  // mount and their open requests would be lost. mapReadyGeneration rerenders
  // this toolbar when the engine is published.
  const addDataReady =
    !rendererCapabilities(primaryRenderer).deferredEngineReady ||
    mapControllerRef.current?.kind === primaryRenderer;
  const capabilities = useMapCapabilities(mapControllerRef);
  const setLoadEditorFeaturesOpen = useAppStore((s) => s.setLoadEditorFeaturesOpen);
  const loadEditorFeaturesOpen = useAppStore((s) => s.ui.loadEditorFeaturesOpen);
  const loadEditorFeaturesLayerId = useAppStore((s) => s.ui.loadEditorFeaturesLayerId);
  const projectName = useAppStore((s) => s.projectName);
  const projectPath = useAppStore((s) => s.projectPath);
  const projectGeneration = useAppStore((s) => s.projectGeneration);
  // The Collaborate dialog's visibility lives in the store so the on-canvas
  // session-status badge can reopen it from outside this component tree (#754).
  // The dialog itself is rendered by DesktopShell (not here) so it survives
  // toolbar-hidden layouts; the toolbar only triggers it via this setter.
  const setCollaborateDialogOpen = useAppStore((s) => s.setCollaborateDialogOpen);

  const {
    plugins,
    isActive,
    getMapControlPosition,
    toggle,
    setMapControlPosition,
    getEffectsSettings,
    previewEffectsSettings,
    commitEffectsSettings,
  } = usePluginRegistry();
  // Plugin ids hidden by the active UI profile (issue #500). Recompute only when
  // the profile changes so the Plugins menu can drop them.
  const uiProfile = useDesktopSettingsStore((state) => state.desktopSettings.uiProfile);
  const hiddenPluginIds = useMemo(
    () =>
      new Set(
        plugins
          .filter((plugin) => !isPluginVisible(uiProfile, plugin.id))
          .map((plugin) => plugin.id),
      ),
    [plugins, uiProfile],
  );
  // Plugins the user can toggle from the Plugins menu, offered as visibility
  // checkboxes in Settings → Interface. Excludes the four plugins that are
  // toggled elsewhere (Effects/Directions/Reverse Geocode via Controls, deck.gl
  // viz via Add Data), matching PluginsMenu's skip list.
  const profilePlugins = useMemo(
    () =>
      plugins
        .filter((plugin) => !MENU_MANAGED_PLUGIN_IDS.has(plugin.id))
        .map((plugin) => ({ id: plugin.id, name: plugin.name })),
    [plugins],
  );
  // mapControllerRef is a stable ref object and createAppAPI dereferences
  // `.current` lazily, so memoizing on the ref keeps a single appApi identity
  // across renders without going stale.
  const appApi = useMemo(() => createAppAPI(mapControllerRef), [mapControllerRef]);

  const panels = useToolbarPanels(appApi);
  // Fill in the geometry kind for vector-tile layers that arrived without it
  // (older projects, sources that don't record it), so their swatch/legend
  // symbols are a dot/line/square rather than a neutral square. Keyed on
  // mapReadyGeneration so it re-runs once the map exists (an early mount before
  // map init would otherwise miss its only chance to attach the idle listener).
  useVectorTileGeometryBackfill(appApi, mapReadyGeneration);
  const osmPbf = useOsmPbfLoader(appApi, projectFiles.setActionError);
  const tilePackage = useTilePackageLoader(appApi, projectFiles.setActionError);
  const consent = useConsentGatedActions({ appApi, isActive, toggle });
  const viewportHistory = useViewportHistory(
    mapControllerRef,
    mapReadyGeneration,
    projectGeneration,
  );

  const { controlsVisible, setControlsVisible, toggleMapControl } = useMapControlVisibility(
    mapControllerRef,
    mapReadyGeneration,
  );
  const addData = useAddDataDialogState(viewer);
  const { openAddDataKind } = addData;
  const dialogs = useToolbarDialogs();
  // Whether this deployment has a usable share host. Read once per render (the
  // deployment env does not change while the app is running) and passed down so
  // the menu, the command palette, and the dialogs agree.
  const shareHost = resolveShareHost();
  const shareAvailable = shareHost.baseUrl != null;

  const handleNewProjectCreated = () => {
    setControlsVisible(resetRuntimeControlsForNewProject(appApi, mapControllerRef));
  };

  // The appApi-backed "add layer" handlers shared by the Add Data menu and the
  // command palette so each panel opens identically from both.
  const addLayer = createAddLayerHandlers({
    appApi,
    openAddDataKind,
    isActive,
    toggle,
    setNetcdfDialogOpen: dialogs.setNetcdfDialogOpen,
    setSpaceborneLidarDialogOpen: dialogs.setSpaceborneLidarDialogOpen,
  });
  const handleOpenPlanetaryComputer = () => openPlanetaryComputerPanel(appApi);

  const allowedCommands = useToolbarCommands({
    t,
    themeMode,
    shareAvailable,
    collaboration,
    capabilities,
    primaryRenderer,
    plugins,
    isActive,
    toggle,
    appApi,
    mapControllerRef,
    projectFiles,
    addLayer,
    openAddDataKind,
    osmPbf,
    tilePackage,
    handleOpenPlanetaryComputer,
    panels,
    consent,
    viewportHistory,
    toggleMapControl,
    onAddComment,
    onOpenDiagnostics,
    onToggleThemeMode,
    viewer,
    addDataReady,
    ...dialogs,
  });
  const [processingMenuOpen, setProcessingMenuOpen] = useState(false);
  // The palette lists what the menus would show under the active UI profile and
  // platform, plus one entry per processing tool (loaded when either searchable
  // surface first opens).
  const paletteCommands = usePaletteCommands({
    commands: allowedCommands,
    open:
      dialogs.commandPaletteOpen ||
      processingMenuOpen ||
      (mobileShell && activeMobileTab === "more"),
    openNetworkTool: consent.openNetworkTool,
  });

  const toolbarButtonSize = compact ? "icon" : "sm";
  const toolbarButtonClass = compact ? "h-8 w-8 shrink-0" : "shrink-0";
  const toolbarIconClassName = cn("h-3.5 w-3.5", showLabels && "sm:me-1");
  // "GeoLibre Desktop" is the *desktop* product name. `isTauri()` alone is true
  // on iOS and Android too — where the app is named plain "GeoLibre" (the bundle
  // name from tauri.ios.conf.json, the home-screen icon, and the store listing),
  // so titling it "GeoLibre Desktop" there contradicts every other surface.
  // A deployment can replace either with its own name (GEOLIBRE_APP_NAME).
  const appTitle = resolveAppName(isTauri() && !isMobile() ? "GeoLibre Desktop" : "GeoLibre");
  const renderToolbarLabel = (label: string) =>
    showLabels ? <span className="hidden sm:inline">{label}</span> : null;
  const chrome: ToolbarChrome = {
    buttonClass: toolbarButtonClass,
    buttonSize: toolbarButtonSize,
    iconClassName: toolbarIconClassName,
    renderLabel: renderToolbarLabel,
  };

  const sharedDialogs = (
    <ToolbarDialogsHost
      viewer={viewer}
      appApi={appApi}
      mapControllerRef={mapControllerRef}
      mapReadyGeneration={mapReadyGeneration}
      projectName={projectName}
      projectGeneration={projectGeneration}
      dialogs={dialogs}
      addData={addData}
      projectFiles={projectFiles}
      consent={consent}
      osmPbf={osmPbf}
      tilePackage={tilePackage}
      loadEditorFeaturesOpen={loadEditorFeaturesOpen}
      loadEditorFeaturesLayerId={loadEditorFeaturesLayerId}
      setLoadEditorFeaturesOpen={setLoadEditorFeaturesOpen}
      allowedCommands={allowedCommands}
      paletteCommands={paletteCommands}
      onProjectCreated={handleNewProjectCreated}
    />
  );
  const gcsExportDialog = <GcsExportDialog open={gcsExportOpen} onOpenChange={setGcsExportOpen} />;

  if (mobileShell) {
    return (
      <>
        <MobileToolbarChrome
          title={projectName.trim() || appTitle}
          viewer={viewer}
          addDataReady={addDataReady}
          themeMode={themeMode}
          diagnosticsErrorCount={diagnosticsErrorCount}
          shareAvailable={shareAvailable}
          measureVisible={panels.measure.visible}
          measureSupported={capabilities.measureTool}
          onToggleMeasure={panels.measure.toggle}
          activeMobileTab={activeMobileTab}
          onSelectMobileTab={onSelectMobileTab}
          mobileSheetHostEl={mobileSheetHostEl}
          appApi={appApi}
          isPluginActive={isActive}
          togglePlugin={toggle}
          addLayer={addLayer}
          openAddDataKind={openAddDataKind}
          dialogs={dialogs}
          projectFiles={projectFiles}
          onToggleThemeMode={onToggleThemeMode}
          onOpenBasemapExtract={onOpenBasemapExtract}
          onAddComment={onAddComment}
          onOpenDiagnostics={onOpenDiagnostics}
          processingCommands={paletteCommands.processingCommands}
          onZoomIn={() => mapControllerRef.current?.zoomIn()}
          onZoomOut={() => mapControllerRef.current?.zoomOut()}
          onResetNorth={() => mapControllerRef.current?.resetNorth()}
          onResetPitch={() => mapControllerRef.current?.resetPitch()}
          onResetPitchBearing={() => mapControllerRef.current?.resetNorthPitch()}
        />
        {!viewer && deploymentCapabilities.has("settings:manage") ? (
          <SettingsDialog
            renderTrigger={false}
            mapControllerRef={mapControllerRef}
            onOpenManagePlugins={() => dialogs.setManagePluginsOpen(true)}
            profilePlugins={profilePlugins}
            themeMode={themeMode}
            onToggleThemeMode={onToggleThemeMode}
          />
        ) : null}
        <ImageControlDialog panel={panels.image} />
        {sharedDialogs}
      </>
    );
  }

  // The header's key handler only routes arrow keys between the menu buttons inside.
  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <header
        onKeyDown={handleMenubarKeyDown}
        className={cn(
          // One row at every width: menus that don't fit scroll horizontally
          // instead of wrapping onto a second row (#871).
          "flex min-h-11 min-w-0 shrink-0 flex-nowrap items-center gap-1 overflow-x-auto border-b bg-card py-1",
          compact ? "px-1.5" : "px-2",
        )}
      >
        <span className="me-1 flex shrink-0 items-center gap-1.5 text-sm font-semibold text-primary md:me-2">
          <Map className="h-4 w-4" />
          {showProjectInfo ? <span className="hidden sm:inline">{appTitle}</span> : null}
        </span>
        {!viewer && isMenuVisible(uiProfile, "project") && (
          <ProjectMenu
            chrome={chrome}
            collaborationEnabled={collaboration.enabled}
            shareHostStatus={shareHost.status}
            onNewProject={() => dialogs.setNewProjectDialogOpen(true)}
            onOpenFromFile={() => void projectFiles.handleOpenFromFile()}
            onOpenFromUrl={() => projectFiles.setProjectUrlDialogOpen(true)}
            onOpenGallery={() => dialogs.setGalleryDialogOpen(true)}
            onImportQgisProject={() => void projectFiles.handleImportQgisProject()}
            onImportArcgisProject={() => void projectFiles.handleImportArcgisProject()}
            onImportLayerStyles={() => void projectFiles.handleImportLayerStyles()}
            onOpenRecent={(path) => {
              void projectFiles.handleOpenRecent(path).then((error) => {
                if (error) projectFiles.setActionError(error);
              });
            }}
            onOpenHistory={onOpenProjectHistory}
            onSave={() => void projectFiles.handleSave()}
            onSaveAs={() => void projectFiles.handleSaveAs()}
            onSaveLayerEdits={() => projectFiles.setSaveLayerEditsDialogOpen(true)}
            onDuplicate={() => projectFiles.handleDuplicate()}
            onSaveAsTemplate={() => projectFiles.handleSaveAsTemplate()}
            onShare={() => dialogs.setShareDialogOpen(true)}
            onExportHtml={() => void projectFiles.handleExportHtml()}
            onExportLayerStyles={() => void projectFiles.handleExportLayerStyles()}
            onExportLayers={() => void projectFiles.handleExportLayers()}
            onExportGeojsonZip={() => void projectFiles.handleExportGeojsonZip()}
            onCollaborate={() => setCollaborateDialogOpen(true)}
            onPrintLayout={() => dialogs.setPrintLayoutOpen(true)}
            onOpenOfflineBasemap={onOpenBasemapExtract}
          />
        )}
        {!viewer && isMenuVisible(uiProfile, "edit") && (
          <EditMenu chrome={chrome} mapControllerRef={mapControllerRef} />
        )}
        {/* `|| primaryRenderer !== "maplibre"`: an admin or custom profile can hide
          the whole "view" menu via `hiddenMenus`, which ViewMenu's own item-level
          override cannot defeat. Hiding it while a project opens on another
          renderer (the Cesium globe or Mapbox) would strand the user there with
          no path back to MapLibre, so the menu stays mounted and renders only
          the Rendering engine submenu (#2217 review). */}
        {/* eslint-disable-next-line local/no-renderer-kind-checks -- the renderer picker's way back to MapLibre */}
        {(isMenuVisible(uiProfile, "view") || primaryRenderer !== "maplibre") && (
          <ViewMenu
            chrome={chrome}
            history={viewportHistory}
            // Engine-neutral: the camera comes from `readView()`, and the zoom
            // limits from the project preferences both engines apply — MapLibre
            // through `setMinZoom`/`setMaxZoom`, the globe by clamping in
            // `animateTo`. Reading them off the MapLibre map would report `null`
            // on the globe and leave Zoom In/Out never showing as "at limit".
            getCamera={() => {
              const engine = mapControllerRef.current;
              const view = engine?.readView();
              if (!view) return null;
              // Prefer the limits the engine actually enforces: MapLibre's
              // effective minZoom is raised above the raw preference when
              // `restrictBounds` is set, so reading the preference alone would
              // leave Zoom Out enabled at the true floor (#2268 review). The
              // preference is the fallback for an engine with no native map,
              // which clamps to it directly.
              const map = engine?.getMap();
              const { map: mapPreferences } = useAppStore.getState().preferences;
              return {
                zoom: view.zoom,
                bearing: view.bearing,
                pitch: view.pitch,
                minZoom: map ? map.getMinZoom() : mapPreferences.minZoom,
                maxZoom: map ? map.getMaxZoom() : mapPreferences.maxZoom,
              };
            }}
            onResetNorth={() => mapControllerRef.current?.resetNorth()}
            onResetPitch={() => mapControllerRef.current?.resetPitch()}
            onResetPitchBearing={() => mapControllerRef.current?.resetNorthPitch()}
            onSetView={() => dialogs.setSetViewOpen(true)}
            // `readView()`, not `getMap()`: both hand-offs only need a camera, which
            // every engine reports, and the MapLibre escape hatch is `null` on the
            // globe — which would have made these silently do nothing now that the
            // menu no longer greys them out (#2268 review).
            onViewInGoogleEarth={() => {
              const view = mapControllerRef.current?.readView();
              if (!view) return;
              void openExternalLink(googleEarthUrl(view.center[1], view.center[0], view.zoom));
            }}
            onViewInGoogleMaps={() => {
              const view = mapControllerRef.current?.readView();
              if (!view) return;
              void openExternalLink(googleMapsUrl(view.center[1], view.center[0], view.zoom));
            }}
            onZoomIn={() => mapControllerRef.current?.zoomIn()}
            onZoomOut={() => mapControllerRef.current?.zoomOut()}
          />
        )}
        {entryMenuOffered("addData", {
          viewer,
          capabilities: deploymentCapabilities,
          menuVisible: isMenuVisible(uiProfile, "addData"),
        }) && (
          <AddDataMenu
            disabled={!addDataReady}
            chrome={chrome}
            addLayer={addLayer}
            osmPbfBusy={osmPbf.busy}
            tilePackageBusy={tilePackage.busy}
            onSetAddDataKind={openAddDataKind}
            onAddGltfModel={() => {
              addData.setAddDataDeckVizKind("scenegraph");
              openAddDataKind("deckgl-viz");
            }}
            onOpenOsmPbfDialog={() => osmPbf.setDialogOpen(true)}
            onOpenTilePackageDialog={() => tilePackage.setDialogOpen(true)}
            onOpenGcsHarvest={() => setGcsExportOpen(true)}
          />
        )}
        {!viewer &&
          isMenuVisible(uiProfile, "processing") &&
          deploymentCapabilities.has("processing:run") && (
            <ProcessingMenu
              chrome={chrome}
              commands={paletteCommands.processingCommands}
              earthEnginePanel={panels.earthEngine}
              open={processingMenuOpen}
              onOpenChange={setProcessingMenuOpen}
              onOpenNetworkTool={consent.openNetworkTool}
              onOpenPlanetaryComputer={handleOpenPlanetaryComputer}
              onOpenGeoreferencer={() => dialogs.setGeoreferencerOpen(true)}
            />
          )}
        {isMenuVisible(uiProfile, "controls") && (
          <ControlsMenu
            chrome={chrome}
            viewer={viewer}
            controlsVisible={controlsVisible}
            panels={panels}
            effectsActive={isActive(EFFECTS_PLUGIN_ID)}
            layerControlActive={isActive(LAYER_CONTROL_PLUGIN_ID)}
            directionsActive={isActive(DIRECTIONS_PLUGIN_ID)}
            reverseGeocodeActive={isActive(REVERSE_GEOCODE_PLUGIN_ID)}
            graticuleActive={isActive(GRATICULE_PLUGIN_ID)}
            cloudsActive={isActive(CLOUDS_PLUGIN_ID)}
            precipitationActive={isActive(PRECIPITATION_PLUGIN_ID)}
            onToggleMapControl={toggleMapControl}
            onToggleLayerControl={() => toggle(LAYER_CONTROL_PLUGIN_ID, appApi)}
            onToggleEffects={() => toggle(EFFECTS_PLUGIN_ID, appApi)}
            getEffectsSettings={getEffectsSettings}
            onPreviewEffectsSettings={previewEffectsSettings}
            onCommitEffectsSettings={commitEffectsSettings}
            onToggleDirections={consent.handleToggleDirections}
            onToggleReverseGeocode={consent.handleToggleReverseGeocode}
            onToggleGraticule={() => toggle(GRATICULE_PLUGIN_ID, appApi)}
            onTogglePointerElevation={consent.handleTogglePointerElevation}
            onToggleClouds={() => toggle(CLOUDS_PLUGIN_ID, appApi)}
            onTogglePrecipitation={() => toggle(PRECIPITATION_PLUGIN_ID, appApi)}
            onOpenFieldCollection={() => dialogs.setFieldCollectionOpen(true)}
            onOpenGpsTracking={() => dialogs.setGpsTrackingOpen(true)}
            onOpenRecordTour={() => dialogs.setRecordTourOpen(true)}
            onOpenRecordVideo={() => dialogs.setRecordVideoOpen(true)}
          />
        )}
        {entryMenuOffered("plugins", {
          viewer,
          capabilities: deploymentCapabilities,
          menuVisible: isMenuVisible(uiProfile, "plugins"),
        }) && (
          <PluginsMenu
            chrome={chrome}
            appApi={appApi}
            plugins={plugins}
            isActive={isActive}
            toggle={toggle}
            getMapControlPosition={getMapControlPosition}
            setMapControlPosition={setMapControlPosition}
            hiddenPluginIds={hiddenPluginIds}
            onOpenManagePlugins={
              IS_MAS_BUILD ? undefined : () => dialogs.setManagePluginsOpen(true)
            }
          />
        )}
        {/* Top-level toolbar menus registered by built-in plugins via
          app.registerToolbarMenu(); external plugin menus render after Help
          (below). Renders nothing when none exist. */}
        {!viewer && deploymentCapabilities.has("plugins:install") ? (
          <PluginToolbarMenus chrome={chrome} placement="builtin" />
        ) : null}
        {!viewer && deploymentCapabilities.has("settings:manage") ? (
          <SettingsDialog
            buttonClassName={toolbarButtonClass}
            buttonSize={toolbarButtonSize}
            iconClassName={toolbarIconClassName}
            mapControllerRef={mapControllerRef}
            showLabels={showLabels}
            onOpenManagePlugins={() => dialogs.setManagePluginsOpen(true)}
            profilePlugins={profilePlugins}
            themeMode={themeMode}
            onToggleThemeMode={onToggleThemeMode}
          />
        ) : null}
        {isMenuVisible(uiProfile, "help") && (
          <HelpMenu
            chrome={chrome}
            viewer={viewer}
            diagnosticsErrorCount={diagnosticsErrorCount}
            onOpenCommandPalette={() => dialogs.setCommandPaletteOpen(true)}
            onOpenShortcuts={() => dialogs.setShortcutsOpen(true)}
            // Only where the Settings dialog is mounted to answer the request.
            onSimplifyInterface={
              !viewer && deploymentCapabilities.has("settings:manage")
                ? openSimplifyInterface
                : undefined
            }
            onOpenDiagnostics={onOpenDiagnostics}
            onCheckForUpdates={() => {
              dialogs.setAboutOpen(true);
              dialogs.setCheckForUpdatesRequest((value) => value + 1);
            }}
            onAbout={() => dialogs.setAboutOpen(true)}
          />
        )}
        {/* External plugin toolbar menus render after Help so third-party menus
          sit at the end of the banner, past the built-in menus. */}
        {!viewer && deploymentCapabilities.has("plugins:install") ? (
          <PluginToolbarMenus chrome={chrome} placement="external" />
        ) : null}
        <div className="ms-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Button
            aria-label={
              themeMode === "dark"
                ? t("toolbar.command.switchToLight")
                : t("toolbar.command.switchToDark")
            }
            className="h-7 w-7 shrink-0"
            onClick={onToggleThemeMode}
            size="icon"
            title={
              themeMode === "dark"
                ? t("toolbar.command.switchToLight")
                : t("toolbar.command.switchToDark")
            }
            variant="ghost"
          >
            {themeMode === "dark" ? (
              <Sun className="h-3.5 w-3.5" />
            ) : (
              <Moon className="h-3.5 w-3.5" />
            )}
          </Button>
          {showProjectInfo ? (
            <>
              <ProjectNameField viewer={viewer} />
              {projectPath ? (
                <span className="hidden truncate lg:inline" title={projectPath}>
                  {projectPath}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
      </header>
      {sharedDialogs}
      {gcsExportDialog}
    </>
  );
}
