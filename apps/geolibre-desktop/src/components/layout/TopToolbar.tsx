import {
  DEFAULT_PROJECT_NAME,
  excludeHiddenFieldsFromProject,
  redactProjectCredentials,
  serializeProject,
  useAppStore,
} from "@geolibre/core";
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
import { Button, cn, Input } from "@geolibre/ui";
import { Map, Moon, Sun } from "lucide-react";
import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useConsentGatedActions } from "../../hooks/useConsentGatedActions";
import type { CollaborationApi } from "../../hooks/useCollaboration";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import { useMapCapabilities } from "../../hooks/useMapCapabilities";
import { useOsmPbfLoader } from "../../hooks/useOsmPbfLoader";
import { createAppAPI, usePluginRegistry } from "../../hooks/usePlugins";
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
import { FieldCollectionDialog } from "./FieldCollectionDialog";
import { PrintLayoutDialog } from "./PrintLayoutDialog";
import { SettingsDialog } from "./SettingsDialog";
import { AddDataMenu } from "./toolbar/AddDataMenu";
import { ConsentNoticeDialogs } from "./toolbar/ConsentNoticeDialogs";
import { openExternalLink, type ToolbarChrome } from "./toolbar/constants";
import { ControlsMenu } from "./toolbar/ControlsMenu";
import { EditMenu } from "./toolbar/EditMenu";
import { HelpMenu } from "./toolbar/HelpMenu";
import {
  AboutDialog,
  AddDataDialog,
  AddNetcdfDialog,
  CommandPalette,
  GeoreferencerDialog,
  GpsTrackingDialog,
  KeyboardShortcutsDialog,
  LoadFeaturesIntoEditorDialog,
  ManagePluginsDialog,
  MountWhenOpened,
  NewProjectDialog,
  ProjectGalleryDialog,
  RecordTourDialog,
  RecordVideoDialog,
  SetViewDialog,
  ShareProjectDialog,
} from "./toolbar/LazyDialogs";
import { OsmPbfDialogs } from "./toolbar/OsmPbfDialogs";
import { PluginsMenu } from "./toolbar/PluginsMenu";
import { PluginToolbarMenus } from "./toolbar/PluginToolbarMenus";
import { ProcessingMenu } from "./toolbar/ProcessingMenu";
import { ProjectFileDialogs } from "./toolbar/ProjectFileDialogs";
import { ProjectMenu } from "./toolbar/ProjectMenu";
import {
  createAddLayerHandlers,
  resetRuntimeControlsForNewProject,
} from "./toolbar/toolbar-actions";
import { ViewMenu } from "./toolbar/ViewMenu";

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
}: TopToolbarProps) {
  const { t } = useTranslation();
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
  const setProjectName = useAppStore((s) => s.setProjectName);
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
  const consent = useConsentGatedActions({ appApi, isActive, toggle });
  const viewportHistory = useViewportHistory(
    mapControllerRef,
    mapReadyGeneration,
    projectGeneration,
  );

  // Tracks an active IME composition so pressing Enter to confirm a CJK
  // candidate doesn't blur the project-name field mid-composition.
  const projectNameComposingRef = useRef(false);

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
  // The palette lists what the menus would show under the active UI profile and
  // platform, plus one entry per processing tool (loaded on first open).
  const paletteCommands = usePaletteCommands({
    commands: allowedCommands,
    open: dialogs.commandPaletteOpen,
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

  return (
    <header
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
          onDuplicate={() => projectFiles.handleDuplicate()}
          onSaveAsTemplate={() => projectFiles.handleSaveAsTemplate()}
          onShare={() => dialogs.setShareDialogOpen(true)}
          onExportHtml={() => void projectFiles.handleExportHtml()}
          onExportLayerStyles={() => void projectFiles.handleExportLayerStyles()}
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
      <MountWhenOpened open={dialogs.newProjectDialogOpen}>
        <NewProjectDialog
          open={dialogs.newProjectDialogOpen}
          onOpenChange={dialogs.handleNewProjectDialogOpenChange}
          showExamples={dialogs.newProjectShowExamples}
          onSaveCurrentProject={projectFiles.handleSave}
          onProjectCreated={handleNewProjectCreated}
          onOpenExample={(url, signal) =>
            projectFiles.openProjectFromShareUrl(url, { asCopy: true, signal })
          }
        />
      </MountWhenOpened>
      {!viewer && isMenuVisible(uiProfile, "addData") && deploymentCapabilities.has("data:add") && (
        <AddDataMenu
          disabled={!addDataReady}
          chrome={chrome}
          addLayer={addLayer}
          osmPbfBusy={osmPbf.busy}
          onSetAddDataKind={openAddDataKind}
          onAddGltfModel={() => {
            addData.setAddDataDeckVizKind("scenegraph");
            openAddDataKind("deckgl-viz");
          }}
          onOpenOsmPbfDialog={() => osmPbf.setDialogOpen(true)}
        />
      )}
      {!viewer &&
        isMenuVisible(uiProfile, "processing") &&
        deploymentCapabilities.has("processing:run") && (
          <ProcessingMenu
            chrome={chrome}
            earthEnginePanel={panels.earthEngine}
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
      {!viewer &&
        isMenuVisible(uiProfile, "plugins") &&
        deploymentCapabilities.has("plugins:install") && (
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
      {/* No plugin marketplace in the Mac App Store build (all its entry
          points are hidden too; this keeps the install surface out of the
          bundle). */}
      {!IS_MAS_BUILD && (
        <MountWhenOpened open={dialogs.managePluginsOpen}>
          <ManagePluginsDialog
            open={dialogs.managePluginsOpen}
            onOpenChange={dialogs.setManagePluginsOpen}
            mapControllerRef={mapControllerRef}
          />
        </MountWhenOpened>
      )}
      {/* Remount on every project load so the composer starts from the opened
          project's saved layout instead of keeping the previous project's
          settings and captured map (GeoLibre discussion #1992). */}
      <PrintLayoutDialog
        key={`print-layout-${projectGeneration}`}
        open={dialogs.printLayoutOpen}
        onOpenChange={dialogs.setPrintLayoutOpen}
        mapControllerRef={mapControllerRef}
      />
      {/* Field Collection and GPS Tracking add features and layers to the
          project, so they follow the Controls menu entries that open them out
          of the read-only viewer preset. Record Tour and Record Video below
          only read the map, so they stay. */}
      {!viewer && (
        <FieldCollectionDialog
          open={dialogs.fieldCollectionOpen}
          onOpenChange={dialogs.setFieldCollectionOpen}
          mapControllerRef={mapControllerRef}
          mapReadyGeneration={mapReadyGeneration}
        />
      )}
      {!viewer && (
        <MountWhenOpened open={dialogs.gpsTrackingOpen}>
          <GpsTrackingDialog
            open={dialogs.gpsTrackingOpen}
            onOpenChange={dialogs.setGpsTrackingOpen}
            mapControllerRef={mapControllerRef}
            mapReadyGeneration={mapReadyGeneration}
          />
        </MountWhenOpened>
      )}
      <MountWhenOpened open={dialogs.recordTourOpen}>
        <RecordTourDialog
          open={dialogs.recordTourOpen}
          onOpenChange={dialogs.setRecordTourOpen}
          mapControllerRef={mapControllerRef}
        />
      </MountWhenOpened>
      <MountWhenOpened open={dialogs.recordVideoOpen}>
        <RecordVideoDialog
          open={dialogs.recordVideoOpen}
          onOpenChange={dialogs.setRecordVideoOpen}
          mapControllerRef={mapControllerRef}
        />
      </MountWhenOpened>
      <MountWhenOpened open={dialogs.georeferencerOpen}>
        <GeoreferencerDialog
          open={dialogs.georeferencerOpen}
          onOpenChange={dialogs.setGeoreferencerOpen}
          mapControllerRef={mapControllerRef}
          mapReadyGeneration={mapReadyGeneration}
        />
      </MountWhenOpened>
      <MountWhenOpened open={dialogs.setViewOpen}>
        <SetViewDialog
          open={dialogs.setViewOpen}
          onOpenChange={dialogs.setSetViewOpen}
          mapControllerRef={mapControllerRef}
        />
      </MountWhenOpened>
      <MountWhenOpened open={loadEditorFeaturesOpen}>
        <LoadFeaturesIntoEditorDialog
          open={loadEditorFeaturesOpen}
          onOpenChange={setLoadEditorFeaturesOpen}
          mapControllerRef={mapControllerRef}
          initialLayerId={loadEditorFeaturesLayerId}
        />
      </MountWhenOpened>
      <MountWhenOpened open={dialogs.shareDialogOpen}>
        <ShareProjectDialog
          open={dialogs.shareDialogOpen}
          onOpenChange={dialogs.setShareDialogOpen}
          currentTitle={projectName}
          getProject={async (title) => {
            // Shared projects are opened on another machine where the local files
            // don't exist, so always embed the vector data (never file references).
            const { project, defaultProjectName } = await projectFiles.buildEmbeddedProject(title);
            const redacted = redactProjectCredentials(excludeHiddenFieldsFromProject(project));
            // Strip path separators, control chars, and other characters that are
            // illegal in filenames so the server gets a predictable name.
            const safeName = defaultProjectName.replace(
              // Includes U+007F (DEL) alongside the C0 control range; both are
              // non-printing and rejected by some filesystems and HTTP servers.
              // eslint-disable-next-line no-control-regex
              /[\u0000-\u001f\u007f/\\:*?"<>|]/g,
              "_",
            );
            return {
              content: serializeProject(redacted.project),
              filename: `${safeName}.geolibre.json`,
              redactedCount: redacted.redactedCount,
            };
          }}
        />
      </MountWhenOpened>
      <MountWhenOpened open={dialogs.galleryDialogOpen}>
        <ProjectGalleryDialog
          open={dialogs.galleryDialogOpen}
          onOpenChange={dialogs.setGalleryDialogOpen}
          onOpenProject={(url, authToken, options) =>
            projectFiles.openProjectFromShareUrl(url, { authToken, ...options })
          }
        />
      </MountWhenOpened>
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
      <MountWhenOpened open={addData.dialogProps.kind !== null}>
        <AddDataDialog {...addData.dialogProps} mapControllerRef={mapControllerRef} />
      </MountWhenOpened>
      <MountWhenOpened open={dialogs.netcdfDialogOpen}>
        <AddNetcdfDialog
          open={dialogs.netcdfDialogOpen}
          appApi={appApi}
          onOpenChange={dialogs.setNetcdfDialogOpen}
        />
      </MountWhenOpened>
      <ProjectFileDialogs projectFiles={projectFiles} />
      <ConsentNoticeDialogs consent={consent} />
      <OsmPbfDialogs osmPbf={osmPbf} />
      <MountWhenOpened open={dialogs.aboutOpen}>
        <AboutDialog
          checkForUpdatesRequest={dialogs.checkForUpdatesRequest}
          open={dialogs.aboutOpen}
          renderTrigger={false}
          onOpenChange={dialogs.setAboutOpen}
        />
      </MountWhenOpened>
      {!viewer && (
        <MountWhenOpened open={dialogs.commandPaletteOpen}>
          <CommandPalette
            open={dialogs.commandPaletteOpen}
            commands={paletteCommands.commands}
            searchOnlyCommands={paletteCommands.toolCommands}
            onOpenChange={dialogs.setCommandPaletteOpen}
          />
        </MountWhenOpened>
      )}
      {!viewer && (
        <MountWhenOpened open={dialogs.shortcutsOpen}>
          <KeyboardShortcutsDialog
            open={dialogs.shortcutsOpen}
            commands={allowedCommands}
            onOpenChange={dialogs.setShortcutsOpen}
          />
        </MountWhenOpened>
      )}
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
            <Input
              aria-label={t("toolbar.item.projectName")}
              className="hidden h-7 w-44 border-transparent px-2 text-xs shadow-none focus-visible:border-input md:block"
              value={projectName}
              readOnly={viewer}
              onChange={(event) => {
                if (viewer) return;
                setProjectName(event.target.value);
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !projectNameComposingRef.current &&
                  !event.nativeEvent.isComposing
                ) {
                  event.currentTarget.blur();
                }
              }}
              onCompositionStart={() => {
                projectNameComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                projectNameComposingRef.current = false;
              }}
              onBlur={(event) => {
                if (viewer) return;
                const nextName = event.target.value.trim();
                // Persist the canonical, locale-independent default name; a
                // translated string would otherwise be written into the saved
                // project file and vary by UI language.
                if (!nextName) setProjectName(DEFAULT_PROJECT_NAME);
              }}
            />
            {projectPath ? (
              <span className="hidden truncate lg:inline" title={projectPath}>
                {projectPath}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
    </header>
  );
}
