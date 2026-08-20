import {
  DEFAULT_PROJECT_NAME,
  excludeHiddenFieldsFromProject,
  redactProjectCredentials,
  serializeProject,
  useAppStore,
} from "@geolibre/core";
import { DEFAULT_BUILT_IN_CONTROL_VISIBILITY, type MapController } from "@geolibre/map";
import {
  closeDuckDBLayerPanel,
  closeEarthEnginePanel,
  closeMaplibreComponentControls,
  closePlanetaryComputerPanel,
  closeRasterLayerPanel,
  closeThreeDTilesLayerPanel,
  closeVectorLayerPanel,
  openFlatGeobufAddVectorLayerPanel,
  openDuckDBLayerPanel,
  openLidarLayerPanel,
  openPlanetaryComputerPanel,
  openPMTilesLayerPanel,
  openRasterLayerPanel,
  openSplattingLayerPanel,
  openStacSearchLayerPanel,
  openZarrLayerPanel,
  openThreeDTilesLayerPanel,
  openVectorLayerPanel,
  setAnnotationLabels,
  setBasemapControlLabels,
  setGraticuleLabels,
  setH3Labels,
  setS2Labels,
  setA5Labels,
  setDggridLabels,
  setDggalLabels,
  setOlcLabels,
  setGeohashLabels,
  setTilecodeLabels,
  setMapillaryLabels,
  setEarthdataGisLabels,
  setOpenAerialMapLabels,
  setArcGisHubLabels,
  setOpenDataCatalogLabels,
  setHuggingFaceLabels,
  setSourceCoopLabels,
  setReverseGeocodeLabels,
  setStacLabels,
  setTimelapseLabels,
  DECK_VIZ_PLUGIN_ID,
  DIRECTIONS_PLUGIN_ID,
  GRATICULE_PLUGIN_ID,
  CLOUDS_PLUGIN_ID,
  PRECIPITATION_PLUGIN_ID,
  REVERSE_GEOCODE_PLUGIN_ID,
  EFFECTS_PLUGIN_ID,
  openRightPanel,
} from "@geolibre/plugins";
import { Button, cn, Input } from "@geolibre/ui";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Compass,
  Crosshair,
  Database,
  FilePen,
  Mountain,
  Share2,
  Users,
  FilePlus2,
  Folder,
  FolderGit2,
  FolderOpen,
  Globe,
  Grid2x2,
  Info,
  Keyboard,
  Link2,
  Map,
  MapPin,
  MessageSquare,
  Moon,
  Palette,
  Printer,
  RefreshCw,
  Save,
  Sparkles,
  Sun,
  Layers,
  Workflow,
  Wrench,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createAppAPI, getPluginManager, usePluginRegistry } from "../../hooks/usePlugins";
import { useConsentGatedActions } from "../../hooks/useConsentGatedActions";
import { useOsmPbfLoader } from "../../hooks/useOsmPbfLoader";
import type { ProjectFileActions } from "../../hooks/useProjectFileActions";
import { useToolbarPanels } from "../../hooks/useToolbarPanels";
import { useVectorTileGeometryBackfill } from "../../hooks/useVectorTileGeometryBackfill";
import type { ThemeMode } from "../../hooks/useThemeMode";
import { isMobile } from "../../lib/is-mobile";
import { isTauri } from "../../lib/tauri-io";
import { isMaptoolkitBasemapActive } from "../../lib/maptoolkit-basemap";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import { MENU_MANAGED_PLUGIN_IDS, isMenuVisible, isPluginVisible } from "../../lib/ui-profile";
import { CommandPalette } from "../command/CommandPalette";
import { KeyboardShortcutsDialog } from "../command/KeyboardShortcutsDialog";
import { useGlobalShortcuts } from "../../hooks/useGlobalShortcuts";
import { useViewportHistory } from "../../hooks/useViewportHistory";
import type { Command } from "../../lib/commands";
import { IS_MAS_BUILD } from "../../lib/build-flags";
import { masHidesDataSource } from "../../lib/mas-build";
import { IS_STORE_BUILD } from "../../lib/updates";
import { AddDataDialog, type AddDataKind } from "./AddDataDialog";
import { serviceUrlParameter } from "../../lib/data-url";
import {
  OPEN_ADD_DATA_EVENT,
  type OpenAddDataDetail,
  type OpenAddDataPostgres,
} from "./add-data/open-add-data";
import { AddNetcdfDialog } from "./AddNetcdfDialog";
import { AboutDialog } from "./AboutDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { ManagePluginsDialog } from "./ManagePluginsDialog";
import { ProjectGalleryDialog } from "./ProjectGalleryDialog";
import { ShareProjectDialog } from "./ShareProjectDialog";
import { resolveShareHost } from "../../lib/share-geolibre";
import type { CollaborationApi } from "../../hooks/useCollaboration";
import { SettingsDialog } from "./SettingsDialog";
import { SetViewDialog } from "./SetViewDialog";
import { PrintLayoutDialog } from "./PrintLayoutDialog";
import { LoadFeaturesIntoEditorDialog } from "./LoadFeaturesIntoEditorDialog";
import { FieldCollectionDialog } from "./FieldCollectionDialog";
import { GpsTrackingDialog } from "./GpsTrackingDialog";
import { RecordTourDialog } from "./RecordTourDialog";
import { RecordVideoDialog } from "./RecordVideoDialog";
import { GeoreferencerDialog } from "./GeoreferencerDialog";
import { AddDataMenu } from "./toolbar/AddDataMenu";
import { ConsentNoticeDialogs } from "./toolbar/ConsentNoticeDialogs";
import { ControlsMenu } from "./toolbar/ControlsMenu";
import { EditMenu } from "./toolbar/EditMenu";
import { ViewMenu } from "./toolbar/ViewMenu";
import { HelpMenu } from "./toolbar/HelpMenu";
import { OsmPbfDialogs } from "./toolbar/OsmPbfDialogs";
import { PluginsMenu } from "./toolbar/PluginsMenu";
import { PluginToolbarMenus } from "./toolbar/PluginToolbarMenus";
import { EARTH_ENGINE_AVAILABLE, ProcessingMenu } from "./toolbar/ProcessingMenu";
import { ProjectFileDialogs } from "./toolbar/ProjectFileDialogs";
import { ProjectMenu } from "./toolbar/ProjectMenu";
import { googleEarthUrl, googleMapsUrl } from "../../lib/external-map-links";
import {
  ADD_DATA_KIND_COMMANDS,
  ALL_BUILT_IN_CONTROL_IDS,
  type AddLayerHandlers,
  CONVERSION_COMMANDS,
  FEEDBACK_URL,
  GITHUB_URL,
  MAP_CONTROL_ITEMS,
  NEW_PROJECT_VISIBLE_BUILT_IN_CONTROLS,
  newProjectToolbarControlVisibility,
  openExternalLink,
  RASTER_TOOL_COMMANDS,
  type ToolbarChrome,
  type ToolbarMapControl,
  VECTOR_TOOL_COMMANDS,
  WEBSITE_URL,
} from "./toolbar/constants";

interface TopToolbarProps {
  compact?: boolean;
  diagnosticsErrorCount: number;
  mapControllerRef: React.RefObject<MapController | null>;
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
  const { t, i18n } = useTranslation();
  // The reverse-geocode plugin lives in the framework-agnostic plugins package
  // and cannot call t() itself, so push the translated popup strings into it
  // here and refresh them whenever the active language changes.
  useEffect(() => {
    setReverseGeocodeLabels({
      lookingUp: t("geocode.reverseLookingUp"),
      noAddress: t("geocode.reverseNoAddress"),
      copyAddress: t("geocode.reverseCopyAddress"),
      failed: t("geocode.reverseFailed"),
    });
    setBasemapControlLabels({
      confirmStyleReplace: (name, count) => t("basemaps.confirmStyleReplace", { name, count }),
    });
    setAnnotationLabels({
      toolbar: t("annotations.toolbar"),
      layerName: t("annotations.layerName"),
      elementsPanelTitle: t("annotations.elementsPanelTitle"),
      tools: {
        text: t("annotations.tools.text"),
        arrow: t("annotations.tools.arrow"),
        rectangle: t("annotations.tools.rectangle"),
        ellipse: t("annotations.tools.ellipse"),
        freehand: t("annotations.tools.freehand"),
        pin: t("annotations.tools.pin"),
        sticky_note: t("annotations.tools.sticky_note"),
        placed_image: t("annotations.tools.placed_image"),
      },
      color: t("annotations.color"),
      width: t("annotations.width"),
      widthOptions: {
        thin: t("annotations.widthOptions.thin"),
        medium: t("annotations.widthOptions.medium"),
        thick: t("annotations.widthOptions.thick"),
      },
      deleteLast: t("annotations.deleteLast"),
      clearAll: t("annotations.clearAll"),
      textPlaceholder: t("annotations.textPlaceholder"),
      pinTitlePrompt: t("annotations.pinTitlePrompt"),
      pinDescPrompt: t("annotations.pinDescPrompt"),
      stickyNotePrompt: t("annotations.stickyNotePrompt"),
      imageUrlPrompt: t("annotations.imageUrlPrompt"),
      cancel: t("annotations.cancel"),
      saveElement: t("annotations.saveElement"),
      atPoint: t("annotations.atPoint"),
      pinnedToExtent: t("annotations.pinnedToExtent"),
    });
    setMapillaryLabels({
      title: t("mapillary.title"),
      getTitle: () => i18n.t("mapillary.title"),
      hint: t("mapillary.hint"),
      noToken: t("mapillary.noToken"),
      tokenPlaceholder: t("mapillary.tokenPlaceholder"),
      tokenSave: t("mapillary.tokenSave"),
      tokenHelp: t("mapillary.tokenHelp"),
      tokenLabel: t("mapillary.tokenLabel"),
      loading: t("mapillary.loading"),
      loadError: t("mapillary.loadError"),
      coverageLines: t("mapillary.coverageLines"),
      coveragePoints: t("mapillary.coveragePoints"),
    });
    setOpenAerialMapLabels({
      hint: t("openAerialMap.hint"),
      search: t("openAerialMap.search"),
      loadMore: t("openAerialMap.loadMore"),
      searching: t("openAerialMap.searching"),
      loadingMore: t("openAerialMap.loadingMore"),
      noResults: t("openAerialMap.noResults"),
      showing: (shown, total) => t("openAerialMap.showing", { shown, total }),
      searchError: (message) => t("openAerialMap.searchError", { message }),
      add: t("openAerialMap.add"),
      remove: t("openAerialMap.remove"),
      zoom: t("openAerialMap.zoom"),
      download: t("openAerialMap.download"),
      metadata: t("openAerialMap.metadata"),
      addTitle: t("openAerialMap.addTitle"),
      removeTitle: t("openAerialMap.removeTitle"),
      addUnavailableTitle: t("openAerialMap.addUnavailableTitle"),
      zoomTitle: t("openAerialMap.zoomTitle"),
      downloadTitle: t("openAerialMap.downloadTitle"),
      metadataTitle: t("openAerialMap.metadataTitle"),
      modeView: t("openAerialMap.modeView"),
      modeDraw: t("openAerialMap.modeDraw"),
      modeBbox: t("openAerialMap.modeBbox"),
      drawHint: t("openAerialMap.drawHint"),
      drawStart: t("openAerialMap.drawStart"),
      drawCancel: t("openAerialMap.drawCancel"),
      drawnBox: (box) => t("openAerialMap.drawnBox", { box }),
      coordWest: t("openAerialMap.coordWest"),
      coordSouth: t("openAerialMap.coordSouth"),
      coordEast: t("openAerialMap.coordEast"),
      coordNorth: t("openAerialMap.coordNorth"),
      coordSearch: t("openAerialMap.coordSearch"),
      bboxInvalid: t("openAerialMap.bboxInvalid"),
      footprintsLayer: t("openAerialMap.footprintsLayer"),
      footprintUnavailable: t("openAerialMap.footprintUnavailable"),
      metadataHeading: t("openAerialMap.metadataHeading"),
      close: t("openAerialMap.close"),
      metaTitle: t("openAerialMap.metaTitle"),
      metaProvider: t("openAerialMap.metaProvider"),
      metaPlatform: t("openAerialMap.metaPlatform"),
      metaResolution: t("openAerialMap.metaResolution"),
      metaAcquired: t("openAerialMap.metaAcquired"),
      metaBounds: t("openAerialMap.metaBounds"),
      metaSource: t("openAerialMap.metaSource"),
      metaRaw: t("openAerialMap.metaRaw"),
    });
    setArcGisHubLabels({
      hint: t("arcgisHub.hint"),
      searchPlaceholder: t("arcgisHub.searchPlaceholder"),
      search: t("arcgisHub.search"),
      searchCurrentView: t("arcgisHub.searchCurrentView"),
      enterKeyword: t("arcgisHub.enterKeyword"),
      loadMore: t("arcgisHub.loadMore"),
      searching: t("arcgisHub.searching"),
      loadingMore: t("arcgisHub.loadingMore"),
      noResults: t("arcgisHub.noResults"),
      searchError: t("arcgisHub.searchError"),
      showing: (shown, total) => t("arcgisHub.showing", { shown, total }),
      noDescription: t("arcgisHub.noDescription"),
      add: t("arcgisHub.add"),
      adding: (title) => t("arcgisHub.adding", { title }),
      added: (title) => t("arcgisHub.added", { title }),
      addError: t("arcgisHub.addError"),
      zoom: t("arcgisHub.zoom"),
      download: t("arcgisHub.download"),
      preparing: (title) => t("arcgisHub.preparing", { title }),
      downloading: (completed, total, title) =>
        t("arcgisHub.downloading", { completed, total, title }),
      downloadStarted: (title) => t("arcgisHub.downloadStarted", { title }),
      downloadFirstLayer: (title, layerCount) =>
        t("arcgisHub.downloadFirstLayer", { title, layerCount }),
      downloadError: t("arcgisHub.downloadError"),
      details: t("arcgisHub.details"),
    });
    setOpenDataCatalogLabels({
      socrataHint: t("openDataCatalogs.socrataHint"),
      ckanHint: t("openDataCatalogs.ckanHint"),
      searchPlaceholder: (name) => t("openDataCatalogs.searchPlaceholder", { name }),
      search: t("openDataCatalogs.search"),
      enterKeyword: t("openDataCatalogs.enterKeyword"),
      loadMore: t("openDataCatalogs.loadMore"),
      searching: t("openDataCatalogs.searching"),
      noResults: t("openDataCatalogs.noResults"),
      showing: (shown, total) => t("openDataCatalogs.showing", { shown, total }),
      noDescription: t("openDataCatalogs.noDescription"),
      add: t("openDataCatalogs.add"),
      details: t("openDataCatalogs.details"),
      adding: (title) => t("openDataCatalogs.adding", { title }),
      added: (title) => t("openDataCatalogs.added", { title }),
      addError: t("openDataCatalogs.addError"),
      searchError: t("openDataCatalogs.searchError"),
    });
    setEarthdataGisLabels({
      hint: t("earthdataGis.hint"),
      searchPlaceholder: t("earthdataGis.searchPlaceholder"),
      search: t("earthdataGis.search"),
      searching: t("earthdataGis.searching"),
      loadingMore: t("earthdataGis.loadingMore"),
      loadMore: t("earthdataGis.loadMore"),
      noResults: t("earthdataGis.noResults"),
      showing: (shown, total) => t("earthdataGis.showing", { shown, total }),
      searchError: (message) => t("earthdataGis.searchError", { message }),
      limitToView: t("earthdataGis.limitToView"),
      limitToViewTitle: t("earthdataGis.limitToViewTitle"),
      filterAll: t("earthdataGis.filterAll"),
      filterImage: t("earthdataGis.filterImage"),
      filterMap: t("earthdataGis.filterMap"),
      filterFeature: t("earthdataGis.filterFeature"),
      kindImage: t("earthdataGis.kindImage"),
      kindMap: t("earthdataGis.kindMap"),
      kindFeature: t("earthdataGis.kindFeature"),
      kindWebMap: t("earthdataGis.kindWebMap"),
      filterWebMap: t("earthdataGis.filterWebMap"),
      webMapAdded: (added, total) =>
        added === total
          ? t("earthdataGis.webMapAdded", { count: added })
          : t("earthdataGis.webMapAddedPartial", { added, total }),
      webMapEmpty: t("earthdataGis.webMapEmpty"),
      add: t("earthdataGis.add"),
      adding: t("earthdataGis.adding"),
      remove: t("earthdataGis.remove"),
      zoom: t("earthdataGis.zoom"),
      details: t("earthdataGis.details"),
      portal: t("earthdataGis.portal"),
      portalTitle: t("earthdataGis.portalTitle"),
      cog: t("earthdataGis.cog"),
      cogTitle: t("earthdataGis.cogTitle"),
      cogHeading: t("earthdataGis.cogHeading"),
      cogAreaView: t("earthdataGis.cogAreaView"),
      cogAreaExtent: t("earthdataGis.cogAreaExtent"),
      cogSize: (width, height) => t("earthdataGis.cogSize", { width, height }),
      cogResolution: (metres) => t("earthdataGis.cogResolution", { metres }),
      cogNote: t("earthdataGis.cogNote"),
      cogDownload: t("earthdataGis.cogDownload"),
      cogDownloading: t("earthdataGis.cogDownloading"),
      cogRetrying: (width, height) => t("earthdataGis.cogRetrying", { width, height }),
      cogConverting: t("earthdataGis.cogConverting"),
      cogDone: (width, height) => t("earthdataGis.cogDone", { width, height }),
      cogFailed: (message) => t("earthdataGis.cogFailed", { message }),
      cogUnavailable: t("earthdataGis.cogUnavailable"),
      cancel: t("earthdataGis.cancel"),
      addTitle: t("earthdataGis.addTitle"),
      removeTitle: t("earthdataGis.removeTitle"),
      zoomTitle: t("earthdataGis.zoomTitle"),
      zoomUnavailableTitle: t("earthdataGis.zoomUnavailableTitle"),
      detailsTitle: t("earthdataGis.detailsTitle"),
      addError: (message) => t("earthdataGis.addError", { message }),
      addTimeout: t("earthdataGis.addTimeout"),
      zoomedToData: t("earthdataGis.zoomedToData"),
      detailsHeading: t("earthdataGis.detailsHeading"),
      close: t("earthdataGis.close"),
      metaTitle: t("earthdataGis.metaTitle"),
      metaType: t("earthdataGis.metaType"),
      metaSummary: t("earthdataGis.metaSummary"),
      metaDescription: t("earthdataGis.metaDescription"),
      metaOwner: t("earthdataGis.metaOwner"),
      metaModified: t("earthdataGis.metaModified"),
      metaTags: t("earthdataGis.metaTags"),
      metaExtent: t("earthdataGis.metaExtent"),
      metaCredits: t("earthdataGis.metaCredits"),
      metaLicense: t("earthdataGis.metaLicense"),
      metaService: t("earthdataGis.metaService"),
      metaPortalItem: t("earthdataGis.metaPortalItem"),
      metaRaw: t("earthdataGis.metaRaw"),
    });
    setSourceCoopLabels({
      hint: t("sourceCoop.hint"),
      searchPlaceholder: t("sourceCoop.searchPlaceholder"),
      search: t("sourceCoop.search"),
      searching: t("sourceCoop.searching"),
      loading: t("sourceCoop.loading"),
      loadError: (message) => t("sourceCoop.loadError", { message }),
      noResults: t("sourceCoop.noResults"),
      retry: t("sourceCoop.retry"),
      featured: t("sourceCoop.featured"),
      showing: (shown, total) => t("sourceCoop.showing", { shown, total }),
      browseAccount: (account) => t("sourceCoop.browseAccount", { account }),
      back: t("sourceCoop.back"),
      files: t("sourceCoop.files"),
      noFiles: t("sourceCoop.noFiles"),
      loadingFiles: t("sourceCoop.loadingFiles"),
      loadMore: t("sourceCoop.loadMore"),
      parent: t("sourceCoop.parent"),
      add: t("sourceCoop.add"),
      adding: t("sourceCoop.adding"),
      added: t("sourceCoop.added"),
      stream: t("sourceCoop.stream"),
      streaming: t("sourceCoop.streaming"),
      remove: t("sourceCoop.remove"),
      download: t("sourceCoop.download"),
      copyUrl: t("sourceCoop.copyUrl"),
      copied: t("sourceCoop.copied"),
      openProduct: t("sourceCoop.openProduct"),
      addTitle: t("sourceCoop.addTitle"),
      streamTitle: t("sourceCoop.streamTitle"),
      removeTitle: t("sourceCoop.removeTitle"),
      downloadTitle: t("sourceCoop.downloadTitle"),
      copyUrlTitle: t("sourceCoop.copyUrlTitle"),
      openProductTitle: t("sourceCoop.openProductTitle"),
      unsupportedTitle: t("sourceCoop.unsupportedTitle"),
      addError: (message) => t("sourceCoop.addError", { message }),
      largeFileWarning: (size) => t("sourceCoop.largeFileWarning", { size }),
      streamHint: (size) => t("sourceCoop.streamHint", { size }),
      tooLargeToOpen: (size, limit) => t("sourceCoop.tooLargeToOpen", { size, limit }),
    });
    setHuggingFaceLabels({
      browseTab: t("huggingFace.browseTab"),
      uploadTab: t("huggingFace.uploadTab"),
      settingsTab: t("huggingFace.settingsTab"),
      hint: t("huggingFace.hint"),
      searchPlaceholder: t("huggingFace.searchPlaceholder"),
      search: t("huggingFace.search"),
      searching: t("huggingFace.searching"),
      loadError: (message) => t("huggingFace.loadError", { message }),
      noResults: t("huggingFace.noResults"),
      retry: t("huggingFace.retry"),
      suggestions: t("huggingFace.suggestions"),
      showing: (count) => t("huggingFace.showing", { count }),
      browseOwner: (owner) => t("huggingFace.browseOwner", { owner }),
      back: t("huggingFace.back"),
      private: t("huggingFace.private"),
      gated: t("huggingFace.gated"),
      privateHint: t("huggingFace.privateHint"),
      stats: (likes, downloads) => t("huggingFace.stats", { likes, downloads }),
      noFiles: t("huggingFace.noFiles"),
      loadingFiles: t("huggingFace.loadingFiles"),
      loadMore: t("huggingFace.loadMore"),
      parent: t("huggingFace.parent"),
      add: t("huggingFace.add"),
      adding: t("huggingFace.adding"),
      stream: t("huggingFace.stream"),
      streaming: t("huggingFace.streaming"),
      remove: t("huggingFace.remove"),
      download: t("huggingFace.download"),
      copyUrl: t("huggingFace.copyUrl"),
      copied: t("huggingFace.copied"),
      openDataset: t("huggingFace.openDataset"),
      addTitle: t("huggingFace.addTitle"),
      streamTitle: t("huggingFace.streamTitle"),
      removeTitle: t("huggingFace.removeTitle"),
      downloadTitle: t("huggingFace.downloadTitle"),
      copyUrlTitle: t("huggingFace.copyUrlTitle"),
      openDatasetTitle: t("huggingFace.openDatasetTitle"),
      unsupportedTitle: t("huggingFace.unsupportedTitle"),
      addError: (message) => t("huggingFace.addError", { message }),
      notRasterIndex: t("huggingFace.notRasterIndex"),
      largeFileWarning: (size) => t("huggingFace.largeFileWarning", { size }),
      streamHint: (size) => t("huggingFace.streamHint", { size }),
      tooLargeToOpen: (size, limit) => t("huggingFace.tooLargeToOpen", { size, limit }),
      tokenLabel: t("huggingFace.tokenLabel"),
      tokenHint: t("huggingFace.tokenHint"),
      tokenPlaceholder: t("huggingFace.tokenPlaceholder"),
      tokenSave: t("huggingFace.tokenSave"),
      tokenClear: t("huggingFace.tokenClear"),
      tokenHelp: t("huggingFace.tokenHelp"),
      tokenChecking: t("huggingFace.tokenChecking"),
      tokenError: (message) => t("huggingFace.tokenError", { message }),
      signedInAs: (name) => t("huggingFace.signedInAs", { name }),
      readOnlyToken: t("huggingFace.readOnlyToken"),
      createHeading: t("huggingFace.createHeading"),
      ownerLabel: t("huggingFace.ownerLabel"),
      datasetNameLabel: t("huggingFace.datasetNameLabel"),
      datasetNamePlaceholder: t("huggingFace.datasetNamePlaceholder"),
      privateLabel: t("huggingFace.privateLabel"),
      create: t("huggingFace.create"),
      creating: t("huggingFace.creating"),
      createdRepo: (repoId) => t("huggingFace.createdRepo", { repoId }),
      createError: (message) => t("huggingFace.createError", { message }),
      uploadHeading: t("huggingFace.uploadHeading"),
      targetLabel: t("huggingFace.targetLabel"),
      targetPlaceholder: t("huggingFace.targetPlaceholder"),
      folderLabel: t("huggingFace.folderLabel"),
      folderPlaceholder: t("huggingFace.folderPlaceholder"),
      chooseFiles: t("huggingFace.chooseFiles"),
      chooseLayer: t("huggingFace.chooseLayer"),
      chooseLayerTitle: t("huggingFace.chooseLayerTitle"),
      layerPickerHeading: t("huggingFace.layerPickerHeading"),
      layerFeatures: (count) => t("huggingFace.layerFeatures", { count }),
      layerOriginalFile: t("huggingFace.layerOriginalFile"),
      layerUnavailable: (name) => t("huggingFace.layerUnavailable", { name }),
      remoteRasterNote: t("huggingFace.remoteRasterNote"),
      noUploadableLayers: t("huggingFace.noUploadableLayers"),
      clearSelection: t("huggingFace.clearSelection"),
      selectedFiles: (count, size) => t("huggingFace.selectedFiles", { count, size }),
      commitMessageLabel: t("huggingFace.commitMessageLabel"),
      commitMessagePlaceholder: t("huggingFace.commitMessagePlaceholder"),
      upload: t("huggingFace.upload"),
      uploadPreparing: t("huggingFace.uploadPreparing"),
      uploadHashing: (name, index, total) => t("huggingFace.uploadHashing", { name, index, total }),
      uploadSending: (name, index, total) => t("huggingFace.uploadSending", { name, index, total }),
      uploadCommitting: t("huggingFace.uploadCommitting"),
      uploadDone: (count) => t("huggingFace.uploadDone", { count }),
      uploadError: (message) => t("huggingFace.uploadError", { message }),
      fileTooLarge: (name, limit) => t("huggingFace.fileTooLarge", { name, limit }),
      selectionTooLarge: (size, limit) => t("huggingFace.selectionTooLarge", { size, limit }),
      openUploaded: t("huggingFace.openUploaded"),
      rgbHeading: t("huggingFace.rgbHeading"),
      rgbHint: t("huggingFace.rgbHint"),
      bandR: t("huggingFace.bandR"),
      bandG: t("huggingFace.bandG"),
      bandB: t("huggingFace.bandB"),
      colormapHeading: t("huggingFace.colormapHeading"),
      colormapHint: t("huggingFace.colormapHint"),
      colormapLabel: t("huggingFace.colormapLabel"),
      engineHeading: t("huggingFace.engineHeading"),
      engineHint: t("huggingFace.engineHint"),
      engineLabel: t("huggingFace.engineLabel"),
      engineAuto: t("huggingFace.engineAuto"),
      engineGpu: t("huggingFace.engineGpu"),
      engineWasm: t("huggingFace.engineWasm"),
      engineTitiler: t("huggingFace.engineTitiler"),
      resetDefaults: t("huggingFace.resetDefaults"),
    });
    setGraticuleLabels({
      title: t("graticule.title"),
      getTitle: () => i18n.t("graticule.title"),
      controlTitle: t("graticule.controlTitle"),
      gridType: t("graticule.gridType"),
      typeGeographic: t("graticule.typeGeographic"),
      typeUtm: t("graticule.typeUtm"),
      spacing: t("graticule.spacing"),
      spacingAuto: t("graticule.spacingAuto"),
      spacingFixed: t("graticule.spacingFixed"),
      interval: t("graticule.interval"),
      intervalMeters: t("graticule.intervalMeters"),
      lineColor: t("graticule.lineColor"),
      lineWidth: t("graticule.lineWidth"),
      lineOpacity: t("graticule.lineOpacity"),
      dashedLines: t("graticule.dashedLines"),
      showLabels: t("graticule.showLabels"),
      labelFormat: t("graticule.labelFormat"),
      formatDecimal: t("graticule.formatDecimal"),
      formatDms: t("graticule.formatDms"),
      labelEdges: t("graticule.labelEdges"),
      edgesLeftBottom: t("graticule.edgesLeftBottom"),
      edgesAll: t("graticule.edgesAll"),
      labelColor: t("graticule.labelColor"),
      labelSize: t("graticule.labelSize"),
    });
    setH3Labels({
      title: t("h3Plugin.title"),
      getTitle: () => i18n.t("h3Plugin.title"),
      controlTitle: t("h3Plugin.controlTitle"),
      autoResolution: t("h3Plugin.autoResolution"),
      resolution: t("h3Plugin.resolution"),
      cellCount: (count) => t("h3Plugin.cellCount", { count }),
      tooManyCells: (limit) => t("h3Plugin.tooManyCells", { limit }),
      fillColor: t("h3Plugin.fillColor"),
      fillOpacity: t("h3Plugin.fillOpacity"),
      lineColor: t("h3Plugin.lineColor"),
      lineWidth: t("h3Plugin.lineWidth"),
      showLabels: t("h3Plugin.showLabels"),
      identifyHint: t("h3Plugin.identifyHint"),
      selectedCell: t("h3Plugin.selectedCell"),
      noSelection: t("h3Plugin.noSelection"),
      copyId: t("h3Plugin.copyId"),
      copied: t("h3Plugin.copied"),
      parent: t("h3Plugin.parent"),
      children: t("h3Plugin.children"),
      neighbors: t("h3Plugin.neighbors"),
      baseCell: t("h3Plugin.baseCell"),
      center: t("h3Plugin.center"),
      pentagon: t("h3Plugin.pentagon"),
      yes: t("h3Plugin.yes"),
      no: t("h3Plugin.no"),
      zoomToCell: t("h3Plugin.zoomToCell"),
      addAsLayer: t("h3Plugin.addAsLayer"),
      exportGeoJson: t("h3Plugin.exportGeoJson"),
      exportCsv: t("h3Plugin.exportCsv"),
      includeNeighbors: t("h3Plugin.includeNeighbors"),
      includeParents: t("h3Plugin.includeParents"),
      showIcosahedron: t("h3Plugin.showIcosahedron"),
    });
    setS2Labels({
      title: t("s2Plugin.title"),
      getTitle: () => i18n.t("s2Plugin.title"),
      controlTitle: t("s2Plugin.controlTitle"),
      autoResolution: t("s2Plugin.autoResolution"),
      resolution: t("s2Plugin.resolution"),
      cellCount: (count) => t("s2Plugin.cellCount", { count }),
      tooManyCells: (limit) => t("s2Plugin.tooManyCells", { limit }),
      fillColor: t("s2Plugin.fillColor"),
      fillOpacity: t("s2Plugin.fillOpacity"),
      lineColor: t("s2Plugin.lineColor"),
      lineWidth: t("s2Plugin.lineWidth"),
      showLabels: t("s2Plugin.showLabels"),
      identifyHint: t("s2Plugin.identifyHint"),
      selectedCell: t("s2Plugin.selectedCell"),
      noSelection: t("s2Plugin.noSelection"),
      copyId: t("s2Plugin.copyId"),
      parent: t("s2Plugin.parent"),
      children: t("s2Plugin.children"),
      neighbors: t("s2Plugin.neighbors"),
      center: t("s2Plugin.center"),
      zoomToCell: t("s2Plugin.zoomToCell"),
      addAsLayer: t("s2Plugin.addAsLayer"),
      exportGeoJson: t("s2Plugin.exportGeoJson"),
      exportCsv: t("s2Plugin.exportCsv"),
      includeNeighbors: t("s2Plugin.includeNeighbors"),
      includeParents: t("s2Plugin.includeParents"),
    });
    setA5Labels({
      title: t("a5Plugin.title"),
      getTitle: () => i18n.t("a5Plugin.title"),
      controlTitle: t("a5Plugin.controlTitle"),
      autoResolution: t("a5Plugin.autoResolution"),
      resolution: t("a5Plugin.resolution"),
      cellCount: (count) => t("a5Plugin.cellCount", { count }),
      tooManyCells: (limit) => t("a5Plugin.tooManyCells", { limit }),
      fillColor: t("a5Plugin.fillColor"),
      fillOpacity: t("a5Plugin.fillOpacity"),
      lineColor: t("a5Plugin.lineColor"),
      lineWidth: t("a5Plugin.lineWidth"),
      showLabels: t("a5Plugin.showLabels"),
      identifyHint: t("a5Plugin.identifyHint"),
      selectedCell: t("a5Plugin.selectedCell"),
      noSelection: t("a5Plugin.noSelection"),
      copyId: t("a5Plugin.copyId"),
      parent: t("a5Plugin.parent"),
      children: t("a5Plugin.children"),
      neighbors: t("a5Plugin.neighbors"),
      center: t("a5Plugin.center"),
      zoomToCell: t("a5Plugin.zoomToCell"),
      addAsLayer: t("a5Plugin.addAsLayer"),
      exportGeoJson: t("a5Plugin.exportGeoJson"),
      exportCsv: t("a5Plugin.exportCsv"),
      includeNeighbors: t("a5Plugin.includeNeighbors"),
      includeParents: t("a5Plugin.includeParents"),
    });
    setDggridLabels({
      title: t("dggridPlugin.title"),
      getTitle: () => i18n.t("dggridPlugin.title"),
      controlTitle: t("dggridPlugin.controlTitle"),
      cellType: t("dggridPlugin.cellType"),
      topologyHexagon: t("dggridPlugin.topologyHexagon"),
      topologyDiamond: t("dggridPlugin.topologyDiamond"),
      topologyTriangle: t("dggridPlugin.topologyTriangle"),
      projection: t("dggridPlugin.projection"),
      aperture: t("dggridPlugin.aperture"),
      autoResolution: t("dggridPlugin.autoResolution"),
      resolution: t("dggridPlugin.resolution"),
      cellCount: (count) => t("dggridPlugin.cellCount", { count }),
      tooManyCells: (limit) => t("dggridPlugin.tooManyCells", { limit }),
      fillColor: t("dggridPlugin.fillColor"),
      fillOpacity: t("dggridPlugin.fillOpacity"),
      lineColor: t("dggridPlugin.lineColor"),
      lineWidth: t("dggridPlugin.lineWidth"),
      showLabels: t("dggridPlugin.showLabels"),
      identifyHint: t("dggridPlugin.identifyHint"),
      selectedCell: t("dggridPlugin.selectedCell"),
      noSelection: t("dggridPlugin.noSelection"),
      copyId: t("dggridPlugin.copyId"),
      parent: t("dggridPlugin.parent"),
      children: t("dggridPlugin.children"),
      neighbors: t("dggridPlugin.neighbors"),
      center: t("dggridPlugin.center"),
      zoomToCell: t("dggridPlugin.zoomToCell"),
      addAsLayer: t("dggridPlugin.addAsLayer"),
      exportGeoJson: t("dggridPlugin.exportGeoJson"),
      exportCsv: t("dggridPlugin.exportCsv"),
      includeNeighbors: t("dggridPlugin.includeNeighbors"),
      includeParents: t("dggridPlugin.includeParents"),
    });
    setDggalLabels({
      title: t("dggalPlugin.title"),
      getTitle: () => i18n.t("dggalPlugin.title"),
      controlTitle: t("dggalPlugin.controlTitle"),
      gridType: t("dggalPlugin.gridType"),
      autoResolution: t("dggalPlugin.autoResolution"),
      resolution: t("dggalPlugin.resolution"),
      cellCount: (count) => t("dggalPlugin.cellCount", { count }),
      tooManyCells: (limit) => t("dggalPlugin.tooManyCells", { limit }),
      fillColor: t("dggalPlugin.fillColor"),
      fillOpacity: t("dggalPlugin.fillOpacity"),
      lineColor: t("dggalPlugin.lineColor"),
      lineWidth: t("dggalPlugin.lineWidth"),
      showLabels: t("dggalPlugin.showLabels"),
      identifyHint: t("dggalPlugin.identifyHint"),
      selectedCell: t("dggalPlugin.selectedCell"),
      noSelection: t("dggalPlugin.noSelection"),
      copyId: t("dggalPlugin.copyId"),
      parent: t("dggalPlugin.parent"),
      children: t("dggalPlugin.children"),
      neighbors: t("dggalPlugin.neighbors"),
      center: t("dggalPlugin.center"),
      zoomToCell: t("dggalPlugin.zoomToCell"),
      addAsLayer: t("dggalPlugin.addAsLayer"),
      exportGeoJson: t("dggalPlugin.exportGeoJson"),
      exportCsv: t("dggalPlugin.exportCsv"),
      includeNeighbors: t("dggalPlugin.includeNeighbors"),
      includeParents: t("dggalPlugin.includeParents"),
    });
    setOlcLabels({
      title: t("olcPlugin.title"),
      getTitle: () => i18n.t("olcPlugin.title"),
      controlTitle: t("olcPlugin.controlTitle"),
      autoResolution: t("olcPlugin.autoResolution"),
      resolution: t("olcPlugin.resolution"),
      cellCount: (count) => t("olcPlugin.cellCount", { count }),
      tooManyCells: (limit) => t("olcPlugin.tooManyCells", { limit }),
      fillColor: t("olcPlugin.fillColor"),
      fillOpacity: t("olcPlugin.fillOpacity"),
      lineColor: t("olcPlugin.lineColor"),
      lineWidth: t("olcPlugin.lineWidth"),
      showLabels: t("olcPlugin.showLabels"),
      identifyHint: t("olcPlugin.identifyHint"),
      selectedCell: t("olcPlugin.selectedCell"),
      noSelection: t("olcPlugin.noSelection"),
      copyId: t("olcPlugin.copyId"),
      parent: t("olcPlugin.parent"),
      children: t("olcPlugin.children"),
      neighbors: t("olcPlugin.neighbors"),
      center: t("olcPlugin.center"),
      zoomToCell: t("olcPlugin.zoomToCell"),
      addAsLayer: t("olcPlugin.addAsLayer"),
      exportGeoJson: t("olcPlugin.exportGeoJson"),
      exportCsv: t("olcPlugin.exportCsv"),
      includeNeighbors: t("olcPlugin.includeNeighbors"),
      includeParent: t("olcPlugin.includeParent"),
    });
    setGeohashLabels({
      title: t("geohashPlugin.title"),
      getTitle: () => i18n.t("geohashPlugin.title"),
      controlTitle: t("geohashPlugin.controlTitle"),
      autoResolution: t("geohashPlugin.autoResolution"),
      resolution: t("geohashPlugin.resolution"),
      cellCount: (count) => t("geohashPlugin.cellCount", { count }),
      tooManyCells: (limit) => t("geohashPlugin.tooManyCells", { limit }),
      fillColor: t("geohashPlugin.fillColor"),
      fillOpacity: t("geohashPlugin.fillOpacity"),
      lineColor: t("geohashPlugin.lineColor"),
      lineWidth: t("geohashPlugin.lineWidth"),
      showLabels: t("geohashPlugin.showLabels"),
      identifyHint: t("geohashPlugin.identifyHint"),
      selectedCell: t("geohashPlugin.selectedCell"),
      noSelection: t("geohashPlugin.noSelection"),
      copyId: t("geohashPlugin.copyId"),
      parent: t("geohashPlugin.parent"),
      children: t("geohashPlugin.children"),
      neighbors: t("geohashPlugin.neighbors"),
      center: t("geohashPlugin.center"),
      zoomToCell: t("geohashPlugin.zoomToCell"),
      addAsLayer: t("geohashPlugin.addAsLayer"),
      exportGeoJson: t("geohashPlugin.exportGeoJson"),
      exportCsv: t("geohashPlugin.exportCsv"),
      includeNeighbors: t("geohashPlugin.includeNeighbors"),
      includeParent: t("geohashPlugin.includeParent"),
    });
    setTilecodeLabels({
      title: t("tilecodePlugin.title"),
      getTitle: () => i18n.t("tilecodePlugin.title"),
      controlTitle: t("tilecodePlugin.controlTitle"),
      autoResolution: t("tilecodePlugin.autoResolution"),
      resolution: t("tilecodePlugin.resolution"),
      cellCount: (count) => t("tilecodePlugin.cellCount", { count }),
      tooManyCells: (limit) => t("tilecodePlugin.tooManyCells", { limit }),
      fillColor: t("tilecodePlugin.fillColor"),
      fillOpacity: t("tilecodePlugin.fillOpacity"),
      lineColor: t("tilecodePlugin.lineColor"),
      lineWidth: t("tilecodePlugin.lineWidth"),
      showLabels: t("tilecodePlugin.showLabels"),
      identifyHint: t("tilecodePlugin.identifyHint"),
      selectedCell: t("tilecodePlugin.selectedCell"),
      noSelection: t("tilecodePlugin.noSelection"),
      copyId: t("tilecodePlugin.copyId"),
      quadkey: t("tilecodePlugin.quadkey"),
      parent: t("tilecodePlugin.parent"),
      children: t("tilecodePlugin.children"),
      neighbors: t("tilecodePlugin.neighbors"),
      center: t("tilecodePlugin.center"),
      zoomToCell: t("tilecodePlugin.zoomToCell"),
      addAsLayer: t("tilecodePlugin.addAsLayer"),
      exportGeoJson: t("tilecodePlugin.exportGeoJson"),
      exportCsv: t("tilecodePlugin.exportCsv"),
      includeNeighbors: t("tilecodePlugin.includeNeighbors"),
      includeParent: t("tilecodePlugin.includeParent"),
    });
    setTimelapseLabels({
      title: t("timelapse.title"),
      provider: t("timelapse.provider"),
      legend: t("timelapse.legend"),
      yearSlider: t("timelapse.yearSlider"),
      play: t("timelapse.play"),
      pause: t("timelapse.pause"),
      speed: t("timelapse.speed"),
      secondsPerYear: t("timelapse.secondsPerYear"),
      secondsPerYearSuffix: t("timelapse.secondsPerYearSuffix"),
      loop: t("timelapse.loop"),
      record: t("timelapse.record"),
      stopRecording: t("timelapse.stopRecording"),
      recording: t("timelapse.recording"),
      recordingFailed: t("timelapse.recordingFailed"),
      recordingUnsupported: t("timelapse.recordingUnsupported"),
      loadingTiles: t("timelapse.loadingTiles"),
    });
    setStacLabels({
      title: t("stacPlugin.title"),
      getTitle: () => i18n.t("stacPlugin.title"),
      footprintLayerName: t("stacPlugin.footprintLayerName"),
      catalogSearch: t("stacPlugin.catalogSearch"),
      catalogSearchPlaceholder: t("stacPlugin.catalogSearchPlaceholder"),
      indexLoading: t("stacPlugin.indexLoading"),
      indexUnavailable: t("stacPlugin.indexUnavailable"),
      indexLoadFailed: t("stacPlugin.indexLoadFailed"),
      urlLabel: t("stacPlugin.urlLabel"),
      connect: t("stacPlugin.connect"),
      connecting: t("stacPlugin.connecting"),
      connected: t("stacPlugin.connected"),
      connectFailed: t("stacPlugin.connectFailed"),
      selectCatalog: t("stacPlugin.selectCatalog"),
      noMatchingCatalogs: t("stacPlugin.noMatchingCatalogs"),
      catalogApiSuffix: t("stacPlugin.catalogApiSuffix"),
      catalogStaticSuffix: t("stacPlugin.catalogStaticSuffix"),
      kindApi: t("stacPlugin.kindApi"),
      kindStatic: t("stacPlugin.kindStatic"),
      collectionsHint: t("stacPlugin.collectionsHint"),
      limitToExtent: t("stacPlugin.limitToExtent"),
      bboxLabel: t("stacPlugin.bboxLabel"),
      bboxPlaceholder: t("stacPlugin.bboxPlaceholder"),
      bboxInvalid: t("stacPlugin.bboxInvalid"),
      drawBbox: t("stacPlugin.drawBbox"),
      cancelDrawing: t("stacPlugin.cancelDrawing"),
      clearDrawnBbox: t("stacPlugin.clearDrawnBbox"),
      drawHint: t("stacPlugin.drawHint"),
      drawnBbox: (bbox) => t("stacPlugin.drawnBbox", { bbox }),
      drawnBboxCleared: t("stacPlugin.drawnBboxCleared"),
      mapNotReady: t("stacPlugin.mapNotReady"),
      startDate: t("stacPlugin.startDate"),
      endDate: t("stacPlugin.endDate"),
      additionalParams: t("stacPlugin.additionalParams"),
      additionalInvalid: t("stacPlugin.additionalInvalid"),
      searchItems: t("stacPlugin.searchItems"),
      clearResults: t("stacPlugin.clearResults"),
      resultsCleared: t("stacPlugin.resultsCleared"),
      searching: t("stacPlugin.searching"),
      loadingMore: t("stacPlugin.loadingMore"),
      noMatchesHere: t("stacPlugin.noMatchesHere"),
      treeEmpty: t("stacPlugin.treeEmpty"),
      treeOpenFailed: t("stacPlugin.treeOpenFailed"),
      noResults: t("stacPlugin.noResults"),
      searchFailed: t("stacPlugin.searchFailed"),
      showing: (count) => t("stacPlugin.showing", { count }),
      showingOfMatched: (count, matched) => t("stacPlugin.showingOfMatched", { count, matched }),
      loadMore: t("stacPlugin.loadMore"),
      renderOptions: t("stacPlugin.renderOptions"),
      renderingEngine: t("stacPlugin.renderingEngine"),
      engineAuto: t("stacPlugin.engineAuto"),
      engineGpu: t("stacPlugin.engineGpu"),
      engineWasm: t("stacPlugin.engineWasm"),
      engineTitiler: t("stacPlugin.engineTitiler"),
      engineHint: t("stacPlugin.engineHint"),
      resizeResults: t("stacPlugin.resizeResults"),
      bands: t("stacPlugin.bands"),
      bandsPlaceholder: t("stacPlugin.bandsPlaceholder"),
      colormap: t("stacPlugin.colormap"),
      colormapDefault: t("stacPlugin.colormapDefault"),
      minValue: t("stacPlugin.minValue"),
      maxValue: t("stacPlugin.maxValue"),
      nodata: t("stacPlugin.nodata"),
      nodataPlaceholder: t("stacPlugin.nodataPlaceholder"),
      renderHint: t("stacPlugin.renderHint"),
      initialStatus: t("stacPlugin.initialStatus"),
      catalogInfo: (title, kind) => t("stacPlugin.catalogInfo", { title, kind }),
      zoom: t("stacPlugin.zoom"),
      add: t("stacPlugin.add"),
      download: t("stacPlugin.download"),
      adding: (asset) => t("stacPlugin.adding", { asset }),
      added: (asset) => t("stacPlugin.added", { asset }),
      addUnsupported: t("stacPlugin.addUnsupported"),
      addFailed: t("stacPlugin.addFailed"),
      addNoSourceLayers: t("stacPlugin.addNoSourceLayers"),
      cogUnsupported: t("stacPlugin.cogUnsupported"),
      formatCog: t("stacPlugin.formatCog"),
      formatGeoJson: t("stacPlugin.formatGeoJson"),
      formatPmtiles: t("stacPlugin.formatPmtiles"),
      formatParquet: t("stacPlugin.formatParquet"),
      formatUnknown: t("stacPlugin.formatUnknown"),
      notAddable: t("stacPlugin.notAddable"),
    });
  }, [t]);

  const setProcessingOpen = useAppStore((s) => s.setProcessingOpen);
  const setConversionOpen = useAppStore((s) => s.setConversionOpen);
  const setVectorToolOpen = useAppStore((s) => s.setVectorToolOpen);
  const setGeocodeOpen = useAppStore((s) => s.setGeocodeOpen);
  const setModelBuilderOpen = useAppStore((s) => s.setModelBuilderOpen);
  const setBatchToolsOpen = useAppStore((s) => s.setBatchToolsOpen);
  const setStyleManagerOpen = useAppStore((s) => s.setStyleManagerOpen);
  const setRasterToolOpen = useAppStore((s) => s.setRasterToolOpen);
  const setSegmentationOpen = useAppStore((s) => s.setSegmentationOpen);
  const setObjectDetectionOpen = useAppStore((s) => s.setObjectDetectionOpen);
  const setSegmentEverythingOpen = useAppStore((s) => s.setSegmentEverythingOpen);
  const setSqlWorkspaceOpen = useAppStore((s) => s.setSqlWorkspaceOpen);
  const setLoadEditorFeaturesOpen = useAppStore((s) => s.setLoadEditorFeaturesOpen);
  const loadEditorFeaturesOpen = useAppStore((s) => s.ui.loadEditorFeaturesOpen);
  const loadEditorFeaturesLayerId = useAppStore((s) => s.ui.loadEditorFeaturesLayerId);
  const setPythonConsoleOpen = useAppStore((s) => s.setPythonConsoleOpen);
  const setAssistantOpen = useAppStore((s) => s.setAssistantOpen);
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

  const [controlsVisible, setControlsVisible] = useState<Record<ToolbarMapControl, boolean>>(() =>
    MAP_CONTROL_ITEMS.reduce(
      (acc, { id }) => {
        acc[id] = DEFAULT_BUILT_IN_CONTROL_VISIBILITY[id];
        return acc;
      },
      {} as Record<ToolbarMapControl, boolean>,
    ),
  );
  const [initialService, setInitialService] = useState(() =>
    viewer || typeof window === "undefined" ? null : serviceUrlParameter(window.location.search),
  );
  const [addDataKind, setAddDataKind] = useState<AddDataKind | null>(() => {
    const kind = initialService?.kind as AddDataKind | undefined;
    // Every other path that opens this dialog from outside the component
    // filters MAS-hidden sources first; a deep link must not be the way around
    // that, even though no service kind is hidden today.
    return kind && !masHidesDataSource(kind) ? kind : null;
  });
  const [addDataTargetGroupId, setAddDataTargetGroupId] = useState<string | null>(null);
  const addDataInitialLayerIdsRef = useRef<Set<string>>(new Set());
  // Every path that opens the dialog outside the OPEN_ADD_DATA_EVENT listener
  // (the Add Data menu, the command palette, the 3D-model button) is ungrouped,
  // so it must drop any group target a previous open left behind — otherwise
  // this session's layers would be swept into that stale, unrelated group when
  // the dialog closes. Only the listener sets a target, and it sets both.
  const openAddDataKind = useCallback((kind: AddDataKind) => {
    setAddDataTargetGroupId(null);
    setAddDataKind(kind);
  }, []);
  // PostgreSQL prefill (saved connection / clicked table) from the Browser panel.
  const [addDataPostgres, setAddDataPostgres] = useState<OpenAddDataPostgres | undefined>(
    undefined,
  );
  // Drop the prefill whenever the dialog isn't on the PostgreSQL source, so a
  // stale prefill can't leak into a later postgres open reached via a path that
  // sets addDataKind directly (command palette / menus) rather than through the
  // Browser-panel event that sets the prefill. The event sets the prefill and
  // kind together, so this never clears a freshly-set prefill.
  useEffect(() => {
    if (addDataKind !== "postgres") setAddDataPostgres(undefined);
  }, [addDataKind]);
  // Let any panel (e.g. the Browser panel's "New connection" action) open the
  // Add Data dialog at a given kind without prop-drilling, mirroring
  // openSettingsSection. This toolbar owns the dialog + its kind state.
  useEffect(() => {
    const onOpenAddData = (event: Event) => {
      // Read-only embeds must not open Add Data via the Browser panel event.
      if (viewer) return;
      const detail = (event as CustomEvent<OpenAddDataDetail>).detail;
      // Reject kinds the Mac App Store build hides so a stray event cannot
      // open a dialog whose backing service is compiled out.
      if (detail?.kind && !masHidesDataSource(detail.kind)) {
        setAddDataPostgres(detail.postgres);
        setAddDataTargetGroupId(detail.groupId ?? null);
        addDataInitialLayerIdsRef.current = new Set(
          useAppStore.getState().layers.map((layer) => layer.id),
        );
        setAddDataKind(detail.kind);
      }
    };
    window.addEventListener(OPEN_ADD_DATA_EVENT, onOpenAddData);
    return () => window.removeEventListener(OPEN_ADD_DATA_EVENT, onOpenAddData);
  }, [viewer]);
  // Deck.gl Layer kind the Add Data dialog opens on (e.g. the 3D-model entry
  // jumps straight to the scenegraph layer type).
  const [addDataDeckVizKind, setAddDataDeckVizKind] = useState<string | undefined>(undefined);
  const [netcdfDialogOpen, setNetcdfDialogOpen] = useState(false);
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);
  const [managePluginsOpen, setManagePluginsOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [galleryDialogOpen, setGalleryDialogOpen] = useState(false);
  // Whether this deployment has a usable share host. Read once per render (the
  // deployment env does not change while the app is running) and passed down so
  // the menu, the command palette, and the dialogs agree.
  const shareHost = resolveShareHost();
  const shareAvailable = shareHost.baseUrl != null;
  const [aboutOpen, setAboutOpen] = useState(false);
  const [printLayoutOpen, setPrintLayoutOpen] = useState(false);
  const [fieldCollectionOpen, setFieldCollectionOpen] = useState(false);
  const [gpsTrackingOpen, setGpsTrackingOpen] = useState(false);
  const [recordTourOpen, setRecordTourOpen] = useState(false);
  const [recordVideoOpen, setRecordVideoOpen] = useState(false);
  const [georeferencerOpen, setGeoreferencerOpen] = useState(false);
  const [setViewOpen, setSetViewOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [checkForUpdatesRequest, setCheckForUpdatesRequest] = useState(0);

  const resetRuntimeControlsForNewProject = () => {
    closeMaplibreComponentControls(appApi);
    closeRasterLayerPanel(appApi);
    closeVectorLayerPanel(appApi);
    closePlanetaryComputerPanel(appApi);
    closeEarthEnginePanel(appApi);
    closeThreeDTilesLayerPanel(appApi);
    closeDuckDBLayerPanel(appApi);
    getPluginManager().restoreProjectState(null, appApi, {
      resetMissingSettings: true,
    });

    for (const control of ALL_BUILT_IN_CONTROL_IDS) {
      mapControllerRef.current?.setBuiltInControlPosition(control, "top-right");
    }
    for (const control of ALL_BUILT_IN_CONTROL_IDS) {
      mapControllerRef.current?.setBuiltInControlVisible(
        control,
        NEW_PROJECT_VISIBLE_BUILT_IN_CONTROLS.has(control),
      );
    }
    setControlsVisible(newProjectToolbarControlVisibility());
  };

  // The appApi-backed "add layer" handlers shared by the Add Data menu and the
  // command palette so each panel opens identically from both.
  const addLayer: AddLayerHandlers = {
    vector: () => openVectorLayerPanel(appApi),
    raster: () => openRasterLayerPanel(appApi),
    stac: () => openStacSearchLayerPanel(appApi),
    flatGeobuf: () => openFlatGeobufAddVectorLayerPanel(appApi),
    pmtiles: () => openPMTilesLayerPanel(appApi),
    zarr: () => openZarrLayerPanel(appApi),
    netcdf: () => setNetcdfDialogOpen(true),
    lidar: () => openLidarLayerPanel(appApi),
    splatting: () => openSplattingLayerPanel(appApi),
    threeDTiles: () => openThreeDTilesLayerPanel(appApi),
    duckdb: () => openDuckDBLayerPanel(appApi),
  };
  const handleOpenPlanetaryComputer = () => openPlanetaryComputerPanel(appApi);

  const toggleMapControl = (control: ToolbarMapControl) => {
    setControlsVisible((current) => {
      const visible = !current[control];
      const updated = mapControllerRef.current?.setBuiltInControlVisible(control, visible) ?? false;
      return updated ? { ...current, [control]: visible } : current;
    });
  };

  // The Maptoolkit logo is Maptoolkit-basemap attribution, required by their
  // terms whenever a Maptoolkit basemap is in use (see isMaptoolkitBasemapActive)
  // and meaningless otherwise, so it tracks that flag automatically: shown the
  // moment a Maptoolkit basemap activates, hidden the moment it doesn't. The
  // imperative call is made directly in the effect body, not inside the
  // setControlsVisible updater — React (Strict Mode) runs a mount effect twice,
  // and add/removeMaptoolkitLogoControl report "already there"/"already gone" as
  // false, which isn't a failure; gating the state update on that return value
  // made the second of the two mount runs read as failed and leave the control
  // (and desired-vs-applied state) permanently out of sync. Calling it
  // unconditionally is safe: both helpers no-op when already in the desired
  // state.
  //
  // Deliberately NOT keyed on mapReadyGeneration (unlike
  // useVectorTileGeometryBackfill above): that generation bumps on every
  // basemap style load, not just the controller's first readiness (see
  // MapCanvas's per-basemap-change `onControllerReadyRef` call), so including
  // it here re-fires this effect on every Maptoolkit-to-Maptoolkit style
  // switch — reapplying the flag and silently clobbering a manual toggle the
  // user made while that basemap stayed active. The effect depends only on
  // the flag itself (edge-triggered), so a manual toggle from the menu is left
  // alone until the flag actually flips; the trade-off is that an activation
  // landing before the controller exists (mapControllerRef.current still
  // null) is not retried, which our mount ordering does not otherwise hit.
  const maptoolkitBasemapActive = useAppStore((s) =>
    isMaptoolkitBasemapActive(s.basemapStyleUrl, s.layers),
  );
  useEffect(() => {
    mapControllerRef.current?.setBuiltInControlVisible("maptoolkit-logo", maptoolkitBasemapActive);
    setControlsVisible((current) =>
      current["maptoolkit-logo"] === maptoolkitBasemapActive
        ? current
        : { ...current, "maptoolkit-logo": maptoolkitBasemapActive },
    );
  }, [maptoolkitBasemapActive, mapControllerRef]);

  // The command registry: the single source of truth shared by the command
  // palette, the global shortcut layer, and the keyboard cheat sheet. Each
  // entry reuses the same handler the matching menu item calls, so behaviour is
  // defined once. Only file operations get global shortcuts to avoid clobbering
  // MapLibre or browser keys; everything else is reachable through the palette.
  const commands: Command[] = [
    // Project
    {
      id: "project.new",
      title: t("toolbar.command.projectNew"),
      group: t("toolbar.commandGroup.project"),
      keywords: "create",
      icon: FilePlus2,
      shortcut: { key: "n", mod: true, shift: false },
      run: () => setNewProjectDialogOpen(true),
    },
    {
      id: "project.open-file",
      title: t("toolbar.command.projectOpenFile"),
      group: t("toolbar.commandGroup.project"),
      keywords: "load",
      icon: FolderOpen,
      shortcut: { key: "o", mod: true, shift: false },
      run: () => void projectFiles.handleOpenFromFile(),
    },
    {
      id: "project.open-url",
      title: t("toolbar.command.projectOpenUrl"),
      group: t("toolbar.commandGroup.project"),
      keywords: "load",
      icon: Link2,
      run: () => projectFiles.setProjectUrlDialogOpen(true),
    },
    {
      id: "project.save",
      title: t("toolbar.command.projectSave"),
      group: t("toolbar.commandGroup.project"),
      icon: Save,
      shortcut: { key: "s", mod: true, shift: false },
      run: () => void projectFiles.handleSave(),
    },
    {
      id: "project.save-as",
      title: t("toolbar.command.projectSaveAs"),
      group: t("toolbar.commandGroup.project"),
      icon: FilePen,
      shortcut: { key: "s", mod: true, shift: true },
      run: () => void projectFiles.handleSaveAs(),
    },
    // Only when the deployment has a usable share host; a command that always
    // failed would be worse than an absent one.
    ...(shareAvailable
      ? [
          {
            id: "project.share",
            title: t("toolbar.command.projectShare"),
            group: t("toolbar.commandGroup.project"),
            icon: Share2,
            run: () => setShareDialogOpen(true),
          },
        ]
      : []),
    // Only surfaced when live collaboration is configured (env flag).
    ...(collaboration.enabled
      ? [
          {
            id: "project.collaborate",
            title: t("toolbar.command.projectCollaborate"),
            group: t("toolbar.commandGroup.project"),
            icon: Users,
            run: () => setCollaborateDialogOpen(true),
          },
        ]
      : []),
    {
      id: "project.print-layout",
      title: t("toolbar.item.printLayoutEllipsis"),
      group: t("toolbar.commandGroup.project"),
      icon: Printer,
      run: () => setPrintLayoutOpen(true),
    },
    // Add Data
    {
      id: "add.vector",
      title: t("toolbar.command.addVectorLayer"),
      group: t("toolbar.commandGroup.addData"),
      icon: Database,
      run: addLayer.vector,
    },
    {
      id: "add.raster",
      title: t("toolbar.command.addRasterLayer"),
      group: t("toolbar.commandGroup.addData"),
      icon: Database,
      run: addLayer.raster,
    },
    {
      id: "add.osm-pbf",
      title: t("toolbar.command.addOsmPbfLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: () => osmPbf.setDialogOpen(true),
    },
    // Sources the Mac App Store build hides in the Add Data menu must not be
    // reachable through the palette either.
    ...ADD_DATA_KIND_COMMANDS.filter(({ kind }) => !masHidesDataSource(kind)).map(
      ({ kind, titleKey }) => ({
        id: `add.${kind}`,
        title: t("toolbar.command.addLayer", { name: t(titleKey) }),
        group: t("toolbar.commandGroup.addData"),
        run: () => openAddDataKind(kind),
      }),
    ),
    {
      id: "add.stac",
      title: t("toolbar.command.addStacLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.stac,
    },
    {
      id: "add.geoparquet",
      title: t("toolbar.command.addGeoparquetLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.vector,
    },
    {
      id: "add.flatgeobuf",
      title: t("toolbar.command.addFlatgeobufLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.flatGeobuf,
    },
    {
      id: "add.pmtiles",
      title: t("toolbar.command.addPmtilesLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.pmtiles,
    },
    {
      id: "add.zarr",
      title: t("toolbar.command.addZarrLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.zarr,
    },
    {
      id: "add.netcdf",
      title: t("toolbar.command.addNetcdfLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.netcdf,
    },
    {
      id: "add.lidar",
      title: t("toolbar.command.addLidarLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.lidar,
    },
    {
      id: "add.splatting",
      title: t("toolbar.command.addSplattingLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.splatting,
    },
    {
      id: "add.3d-tiles",
      title: t("toolbar.command.add3dTilesLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.threeDTiles,
    },
    {
      id: "add.duckdb",
      title: t("toolbar.command.addDuckdbLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.duckdb,
    },
    {
      id: "add.comment",
      title: t("comments.addDialogTitle"),
      group: t("toolbar.commandGroup.addData"),
      keywords: "review note feedback",
      icon: MessageSquare,
      shortcut: { key: "c", shift: false },
      run: onAddComment,
    },
    // Processing
    {
      id: "proc.whitebox",
      title: t("toolbar.command.whiteboxTools"),
      group: t("toolbar.commandGroup.processing"),
      icon: Wrench,
      run: () => setProcessingOpen(true),
    },
    {
      id: "proc.sql",
      title: t("toolbar.command.sqlWorkspace"),
      group: t("toolbar.commandGroup.processing"),
      icon: Wrench,
      run: () => setSqlWorkspaceOpen(true),
    },
    {
      id: "proc.python",
      title: t("toolbar.command.pythonConsole"),
      group: t("toolbar.commandGroup.processing"),
      keywords: "python console pyodide script repl",
      icon: Wrench,
      run: () => setPythonConsoleOpen(true),
    },
    {
      id: "proc.assistant",
      title: t("toolbar.command.assistant"),
      group: t("toolbar.commandGroup.processing"),
      keywords: "assistant ai chat llm natural language gemini agent",
      icon: Sparkles,
      run: () => setAssistantOpen(true),
    },
    {
      id: "proc.geocode",
      title: t("toolbar.command.geocode"),
      group: t("toolbar.commandGroup.processing"),
      keywords: "geocode address csv nominatim",
      icon: MapPin,
      run: () => setGeocodeOpen(true),
    },
    {
      id: "proc.modelBuilder",
      title: t("toolbar.command.modelBuilder"),
      group: t("toolbar.commandGroup.processing"),
      keywords: "model builder pipeline chain modeler workflow graph canvas node",
      icon: Workflow,
      run: () => setModelBuilderOpen(true),
    },
    {
      id: "proc.batchTools",
      title: t("toolbar.command.batchTools"),
      group: t("toolbar.commandGroup.processing"),
      keywords: "batch bulk many layers repeat vector tool",
      icon: Layers,
      run: () => setBatchToolsOpen(true),
    },
    // The Mac App Store build omits AI Segmentation: it is sidecar-only (the
    // App Sandbox forbids the sidecar) and has no client-side fallback.
    ...(IS_MAS_BUILD
      ? []
      : [
          {
            id: "proc.segmentation",
            title: t("toolbar.command.segmentation"),
            group: t("toolbar.commandGroup.processing"),
            keywords: "segmentation samgeo sam3 ai segment imagery",
            icon: Sparkles,
            run: () => setSegmentationOpen(true),
          },
        ]),
    {
      id: "proc.objectDetection",
      title: t("toolbar.command.objectDetection"),
      group: t("toolbar.commandGroup.processing"),
      keywords: "object detection yolo onnx ai detect imagery boxes",
      icon: Sparkles,
      run: () => setObjectDetectionOpen(true),
    },
    {
      id: "proc.segmentEverything",
      title: t("toolbar.command.segmentEverything"),
      group: t("toolbar.commandGroup.processing"),
      keywords: "segment everything slimsam sam automatic mask imagery polygons",
      icon: Sparkles,
      run: () => setSegmentEverythingOpen(true),
    },
    ...CONVERSION_COMMANDS.map(({ kind, titleKey }) => ({
      id: `proc.conversion.${kind}`,
      title: t(titleKey),
      group: t("toolbar.commandGroup.processing"),
      keywords: "conversion convert",
      run: () => setConversionOpen(kind),
    })),
    ...VECTOR_TOOL_COMMANDS.map(({ kind, titleKey }) => ({
      id: `proc.vector.${kind}`,
      title: t(titleKey),
      group: t("toolbar.commandGroup.processing"),
      keywords: "vector tool",
      run: () => setVectorToolOpen(kind),
    })),
    ...RASTER_TOOL_COMMANDS.map(({ kind, titleKey }) => ({
      id: `proc.raster.${kind}`,
      title: t(titleKey),
      group: t("toolbar.commandGroup.processing"),
      keywords: "raster tool",
      run: () => setRasterToolOpen(kind),
    })),
    {
      id: "proc.planetary-computer",
      title: t("toolbar.command.planetaryComputer"),
      group: t("toolbar.commandGroup.processing"),
      run: handleOpenPlanetaryComputer,
    },
    // Earth Engine sign-in needs the Rust loopback OAuth listener, which the
    // Apple App Store builds (Mac App Store and iOS) compile out so the app
    // claims no `com.apple.security.network.server` entitlement. Shares the
    // ProcessingMenu gate's module-level constant rather than recomputing it in
    // this array, which is rebuilt on every render.
    ...(EARTH_ENGINE_AVAILABLE
      ? [
          {
            id: "proc.earth-engine",
            title: t("toolbar.command.earthEngine"),
            group: t("toolbar.commandGroup.processing"),
            run: panels.earthEngine.toggle,
          },
        ]
      : []),
    // Controls
    ...MAP_CONTROL_ITEMS.map((control) => ({
      id: `control.${control.id}`,
      title: t("toolbar.command.toggleControl", {
        name: t(control.labelKey),
      }),
      group: t("toolbar.commandGroup.controls"),
      keywords: "control toggle map",
      run: () => toggleMapControl(control.id),
    })),
    {
      id: "control.effects",
      title: t("toolbar.command.toggleAtmosphereEffects"),
      group: t("toolbar.commandGroup.controls"),
      run: () => toggle(EFFECTS_PLUGIN_ID, appApi),
    },
    {
      id: "control.directions",
      title: t("toolbar.command.toggleDirections"),
      group: t("toolbar.commandGroup.controls"),
      run: consent.handleToggleDirections,
    },
    {
      id: "control.search",
      title: t("toolbar.command.toggleSearch"),
      group: t("toolbar.commandGroup.controls"),
      run: panels.searchPlaces.toggle,
    },
    {
      id: "control.colorbar",
      title: t("toolbar.command.toggleColorbar"),
      group: t("toolbar.commandGroup.controls"),
      run: panels.colorbar.toggle,
    },
    {
      id: "control.legend",
      title: t("toolbar.command.toggleLegend"),
      group: t("toolbar.commandGroup.controls"),
      run: panels.legend.toggle,
    },
    {
      id: "control.html",
      title: t("toolbar.command.toggleHtmlPanel"),
      group: t("toolbar.commandGroup.controls"),
      run: panels.html.toggle,
    },
    {
      id: "control.measure",
      title: t("toolbar.command.toggleMeasure"),
      group: t("toolbar.commandGroup.controls"),
      run: panels.measure.toggle,
    },
    {
      id: "control.bookmark",
      title: t("toolbar.command.toggleBookmark"),
      group: t("toolbar.commandGroup.controls"),
      run: panels.bookmark.toggle,
    },
    {
      id: "control.minimap",
      title: t("toolbar.command.toggleMinimap"),
      group: t("toolbar.commandGroup.controls"),
      run: panels.minimap.toggle,
    },
    {
      id: "control.view-state",
      title: t("toolbar.command.toggleViewState"),
      group: t("toolbar.commandGroup.controls"),
      run: panels.viewState.toggle,
    },
    // View
    {
      id: "view.zoom-in",
      title: t("toolbar.command.zoomIn"),
      group: t("toolbar.commandGroup.view"),
      keywords: "zoom in closer magnify scale",
      icon: ZoomIn,
      run: () => mapControllerRef.current?.zoomIn(),
    },
    {
      id: "view.zoom-out",
      title: t("toolbar.command.zoomOut"),
      group: t("toolbar.commandGroup.view"),
      keywords: "zoom out farther wider scale",
      icon: ZoomOut,
      run: () => mapControllerRef.current?.zoomOut(),
    },
    {
      id: "view.previous",
      title: t("toolbar.command.previousView"),
      group: t("toolbar.commandGroup.view"),
      keywords: "back history viewport extent previous undo pan zoom",
      icon: ArrowLeft,
      // "[" / "]" step through viewport history (unbound by MapLibre).
      shortcut: { key: "[" },
      run: viewportHistory.goBack,
    },
    {
      id: "view.next",
      title: t("toolbar.command.nextView"),
      group: t("toolbar.commandGroup.view"),
      keywords: "forward history viewport extent next redo pan zoom",
      icon: ArrowRight,
      shortcut: { key: "]" },
      run: viewportHistory.goForward,
    },
    {
      id: "view.reset-north",
      title: t("toolbar.command.resetNorth"),
      group: t("toolbar.commandGroup.view"),
      keywords: "north bearing rotation rotate compass orientation",
      icon: Compass,
      // Plain "N" (Google Earth Pro's north-up shortcut). No modifier, so it
      // never clashes with ⌘/Ctrl+N (New project) and leaves MapLibre's own
      // arrow/zoom keys untouched.
      shortcut: { key: "n" },
      run: () => mapControllerRef.current?.resetNorth(),
    },
    {
      id: "view.reset-pitch",
      title: t("toolbar.command.resetPitch"),
      group: t("toolbar.commandGroup.view"),
      keywords: "pitch tilt top down overhead flat level plan 2d reset",
      icon: Grid2x2,
      // Plain "U" resets pitch to a top-down view (Google Earth Pro's shortcut).
      shortcut: { key: "u" },
      run: () => mapControllerRef.current?.resetPitch(),
    },
    {
      id: "view.reset-pitch-bearing",
      title: t("toolbar.command.resetPitchBearing"),
      group: t("toolbar.commandGroup.view"),
      keywords: "pitch bearing tilt rotation north flat level 3d",
      icon: Mountain,
      // Plain "R" resets pitch and bearing (like Google Earth Pro's reset view).
      shortcut: { key: "r" },
      run: () => mapControllerRef.current?.resetNorthPitch(),
    },
    {
      id: "view.set-view",
      title: t("toolbar.command.setView"),
      group: t("toolbar.commandGroup.view"),
      keywords:
        "set view go to coordinates center zoom pitch bearing camera location longitude latitude",
      icon: Crosshair,
      run: () => setSetViewOpen(true),
    },
    {
      id: "view.comments",
      title: t("toolbar.command.viewComments"),
      group: t("toolbar.commandGroup.view"),
      keywords: "comments review threads notes annotations pins",
      icon: MessageSquare,
      run: () => openRightPanel("comments"),
    },
    {
      id: "view.theme",
      title:
        themeMode === "dark"
          ? t("toolbar.command.switchToLight")
          : t("toolbar.command.switchToDark"),
      group: t("toolbar.commandGroup.view"),
      keywords: "theme dark light appearance",
      icon: themeMode === "dark" ? Sun : Moon,
      run: onToggleThemeMode,
    },
    // Help
    {
      id: "help.shortcuts",
      title: t("toolbar.command.keyboardShortcuts"),
      group: t("toolbar.commandGroup.help"),
      keywords: "hotkeys cheat sheet",
      icon: Keyboard,
      run: () => setShortcutsOpen(true),
    },
    {
      id: "help.website",
      title: t("toolbar.command.website"),
      group: t("toolbar.commandGroup.help"),
      keywords: "home page site geolibre.app",
      icon: Globe,
      run: () => void openExternalLink(WEBSITE_URL),
    },
    {
      id: "help.github",
      title: t("toolbar.command.githubRepository"),
      group: t("toolbar.commandGroup.help"),
      keywords: "source code repo git opengeos",
      icon: FolderGit2,
      run: () => void openExternalLink(GITHUB_URL),
    },
    {
      id: "help.diagnostics",
      title: t("toolbar.command.diagnostics"),
      group: t("toolbar.commandGroup.help"),
      icon: Bug,
      run: onOpenDiagnostics,
    },
    {
      id: "help.feedback",
      title: t("toolbar.command.giveFeedback"),
      group: t("toolbar.commandGroup.help"),
      icon: MessageSquare,
      run: () => void openExternalLink(FEEDBACK_URL),
    },
    // The Microsoft Store build omits the "Check for updates" command so the app
    // updates only through the Store (policy 10.2.5).
    ...(IS_STORE_BUILD
      ? []
      : [
          {
            id: "help.updates",
            title: t("toolbar.command.checkForUpdates"),
            group: t("toolbar.commandGroup.help"),
            icon: RefreshCw,
            run: () => {
              setAboutOpen(true);
              setCheckForUpdatesRequest((value) => value + 1);
            },
          },
        ]),
    {
      id: "help.about",
      title: t("toolbar.command.about"),
      group: t("toolbar.commandGroup.help"),
      icon: Info,
      run: () => setAboutOpen(true),
    },
    // Plugins — one toggle per registered plugin. Atmospheric Effects,
    // Directions, Reverse Geocode, Gridlines, and the deck.gl viz renderer are
    // excluded here because they are surfaced under Controls / Add Data instead
    // (matching the menus).
    ...plugins
      .filter(
        (plugin) =>
          plugin.id !== EFFECTS_PLUGIN_ID &&
          plugin.id !== DIRECTIONS_PLUGIN_ID &&
          plugin.id !== REVERSE_GEOCODE_PLUGIN_ID &&
          plugin.id !== GRATICULE_PLUGIN_ID &&
          plugin.id !== CLOUDS_PLUGIN_ID &&
          plugin.id !== PRECIPITATION_PLUGIN_ID &&
          plugin.id !== DECK_VIZ_PLUGIN_ID,
      )
      .map((plugin) => ({
        id: `plugin.${plugin.id}`,
        title: t("toolbar.command.togglePlugin", { name: plugin.name }),
        group: t("toolbar.commandGroup.plugins"),
        keywords: isActive(plugin.id) ? "plugin deactivate" : "plugin activate",
        run: () => toggle(plugin.id, appApi),
      })),
    // Settings
    // The Mac App Store build omits the plugin marketplace: installing
    // external plugins is not allowed there, and bundled plugins need no
    // management. Same pattern as the Store build's update command above.
    ...(IS_MAS_BUILD
      ? []
      : [
          {
            id: "settings.manage-plugins",
            title: t("toolbar.command.managePlugins"),
            group: t("toolbar.commandGroup.settings"),
            keywords: "install external plugin marketplace",
            run: () => setManagePluginsOpen(true),
          },
        ]),
    {
      id: "settings.style-manager",
      title: t("toolbar.command.styleManager"),
      group: t("toolbar.commandGroup.settings"),
      keywords: "style manager saved styles symbol ramp label preset library",
      icon: Palette,
      run: () => setStyleManagerOpen(true),
    },
  ];

  // The viewer preset hides every authoring menu, so the surfaces that reach
  // those commands without a menu go with them: the command palette
  // (Ctrl/Cmd+K) and the cheat sheet (?) are not mounted, and the Help menu
  // drops its entries for them (see `viewer` on HelpMenu). Otherwise a
  // `layout=viewer` embed would still answer Ctrl+N with "New Project", or
  // overwrite the host's project on Ctrl+S — exactly what the read-only chrome
  // promises it cannot do.
  //
  // The shortcut layer is narrowed rather than switched off, because the View
  // menu *does* stay visible in this mode: `view.*` is camera and theme work
  // only, so dropping its keys would leave those items clickable but silently
  // keyless. Everything else carrying a `shortcut` authors the project
  // (`project.*`, `add.comment`), so filtering to `view.*` drops exactly the
  // authoring keyboard surface.
  const shortcutCommands = useMemo(
    () => (viewer ? commands.filter((command) => command.id.startsWith("view.")) : commands),
    [commands, viewer],
  );
  useGlobalShortcuts({
    commands: shortcutCommands,
    onOpenPalette: viewer ? undefined : () => setCommandPaletteOpen(true),
    onOpenShortcuts: viewer ? undefined : () => setShortcutsOpen(true),
  });

  const toolbarButtonSize = compact ? "icon" : "sm";
  const toolbarButtonClass = compact ? "h-8 w-8 shrink-0" : "shrink-0";
  // Class for "secondary" toolbar menus that may be hidden on narrow screens to
  // reduce toolbar wrapping. The menu stays reachable other ways (e.g. Edit's
  // actions also have keyboard shortcuts). To make a future menu hideable, give
  // its trigger Button this class instead of `toolbarButtonClass`.
  const toolbarSecondaryButtonClass = cn(toolbarButtonClass, "hidden md:inline-flex");
  const toolbarIconClassName = cn("h-3.5 w-3.5", showLabels && "sm:me-1");
  // "GeoLibre Desktop" is the *desktop* product name. `isTauri()` alone is true
  // on iOS and Android too — where the app is named plain "GeoLibre" (the bundle
  // name from tauri.ios.conf.json, the home-screen icon, and the store listing),
  // so titling it "GeoLibre Desktop" there contradicts every other surface.
  const appTitle = isTauri() && !isMobile() ? "GeoLibre Desktop" : "GeoLibre";
  const renderToolbarLabel = (label: string) =>
    showLabels ? <span className="hidden sm:inline">{label}</span> : null;
  const chrome: ToolbarChrome = {
    buttonClass: toolbarButtonClass,
    secondaryButtonClass: toolbarSecondaryButtonClass,
    buttonSize: toolbarButtonSize,
    iconClassName: toolbarIconClassName,
    renderLabel: renderToolbarLabel,
  };

  return (
    <header
      className={cn(
        "flex min-h-11 min-w-0 shrink-0 items-center gap-1 border-b bg-card py-1",
        compact
          ? "flex-nowrap overflow-x-auto px-1.5"
          : // Wrap below md; scroll a single row at md+ so tablets reach every menu (#871).
            "flex-wrap px-2 md:flex-nowrap md:overflow-x-auto",
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
          onNewProject={() => setNewProjectDialogOpen(true)}
          onOpenFromFile={() => void projectFiles.handleOpenFromFile()}
          onOpenFromUrl={() => projectFiles.setProjectUrlDialogOpen(true)}
          onOpenGallery={() => setGalleryDialogOpen(true)}
          onImportQgisProject={() => void projectFiles.handleImportQgisProject()}
          onImportArcgisProject={() => void projectFiles.handleImportArcgisProject()}
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
          onShare={() => setShareDialogOpen(true)}
          onExportHtml={() => void projectFiles.handleExportHtml()}
          onCollaborate={() => setCollaborateDialogOpen(true)}
          onPrintLayout={() => setPrintLayoutOpen(true)}
          onOpenOfflineBasemap={onOpenBasemapExtract}
        />
      )}
      {!viewer && isMenuVisible(uiProfile, "edit") && (
        <EditMenu chrome={chrome} mapControllerRef={mapControllerRef} />
      )}
      {isMenuVisible(uiProfile, "view") && (
        <ViewMenu
          chrome={chrome}
          history={viewportHistory}
          getCamera={() => {
            const map = mapControllerRef.current?.getMap();
            if (!map) return null;
            return {
              zoom: map.getZoom(),
              bearing: map.getBearing(),
              pitch: map.getPitch(),
              minZoom: map.getMinZoom(),
              maxZoom: map.getMaxZoom(),
            };
          }}
          onResetNorth={() => mapControllerRef.current?.resetNorth()}
          onResetPitch={() => mapControllerRef.current?.resetPitch()}
          onResetPitchBearing={() => mapControllerRef.current?.resetNorthPitch()}
          onSetView={() => setSetViewOpen(true)}
          onViewInGoogleEarth={() => {
            const map = mapControllerRef.current?.getMap();
            if (!map) return;
            const center = map.getCenter();
            void openExternalLink(googleEarthUrl(center.lat, center.lng, map.getZoom()));
          }}
          onViewInGoogleMaps={() => {
            const map = mapControllerRef.current?.getMap();
            if (!map) return;
            const center = map.getCenter();
            void openExternalLink(googleMapsUrl(center.lat, center.lng, map.getZoom()));
          }}
          onZoomIn={() => mapControllerRef.current?.zoomIn()}
          onZoomOut={() => mapControllerRef.current?.zoomOut()}
        />
      )}
      <NewProjectDialog
        open={newProjectDialogOpen}
        onOpenChange={setNewProjectDialogOpen}
        onSaveCurrentProject={projectFiles.handleSave}
        onProjectCreated={resetRuntimeControlsForNewProject}
      />
      {!viewer && isMenuVisible(uiProfile, "addData") && (
        <AddDataMenu
          chrome={chrome}
          addLayer={addLayer}
          osmPbfBusy={osmPbf.busy}
          onSetAddDataKind={openAddDataKind}
          onAddGltfModel={() => {
            setAddDataDeckVizKind("scenegraph");
            openAddDataKind("deckgl-viz");
          }}
          onOpenOsmPbfDialog={() => osmPbf.setDialogOpen(true)}
        />
      )}
      {!viewer && isMenuVisible(uiProfile, "processing") && (
        <ProcessingMenu
          chrome={chrome}
          earthEnginePanel={panels.earthEngine}
          onOpenNetworkTool={consent.openNetworkTool}
          onOpenPlanetaryComputer={handleOpenPlanetaryComputer}
          onOpenGeoreferencer={() => setGeoreferencerOpen(true)}
        />
      )}
      {isMenuVisible(uiProfile, "controls") && (
        <ControlsMenu
          chrome={chrome}
          viewer={viewer}
          controlsVisible={controlsVisible}
          panels={panels}
          effectsActive={isActive(EFFECTS_PLUGIN_ID)}
          directionsActive={isActive(DIRECTIONS_PLUGIN_ID)}
          reverseGeocodeActive={isActive(REVERSE_GEOCODE_PLUGIN_ID)}
          graticuleActive={isActive(GRATICULE_PLUGIN_ID)}
          cloudsActive={isActive(CLOUDS_PLUGIN_ID)}
          precipitationActive={isActive(PRECIPITATION_PLUGIN_ID)}
          onToggleMapControl={toggleMapControl}
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
          onOpenFieldCollection={() => setFieldCollectionOpen(true)}
          onOpenGpsTracking={() => setGpsTrackingOpen(true)}
          onOpenRecordTour={() => setRecordTourOpen(true)}
          onOpenRecordVideo={() => setRecordVideoOpen(true)}
        />
      )}
      {!viewer && isMenuVisible(uiProfile, "plugins") && (
        <PluginsMenu
          chrome={chrome}
          appApi={appApi}
          plugins={plugins}
          isActive={isActive}
          toggle={toggle}
          getMapControlPosition={getMapControlPosition}
          setMapControlPosition={setMapControlPosition}
          hiddenPluginIds={hiddenPluginIds}
        />
      )}
      {/* Top-level toolbar menus registered by built-in plugins via
          app.registerToolbarMenu(); external plugin menus render after Help
          (below). Renders nothing when none exist. */}
      {!viewer ? <PluginToolbarMenus chrome={chrome} placement="builtin" /> : null}
      {!viewer ? (
        <SettingsDialog
          buttonClassName={toolbarButtonClass}
          buttonSize={toolbarButtonSize}
          iconClassName={toolbarIconClassName}
          mapControllerRef={mapControllerRef}
          showLabels={showLabels}
          onOpenManagePlugins={() => setManagePluginsOpen(true)}
          profilePlugins={profilePlugins}
          themeMode={themeMode}
          onToggleThemeMode={onToggleThemeMode}
        />
      ) : null}
      {/* No plugin marketplace in the Mac App Store build (all its entry
          points are hidden too; this keeps the install surface out of the
          bundle). */}
      {!IS_MAS_BUILD && (
        <ManagePluginsDialog
          open={managePluginsOpen}
          onOpenChange={setManagePluginsOpen}
          mapControllerRef={mapControllerRef}
        />
      )}
      {/* Remount on every project load so the composer starts from the opened
          project's saved layout instead of keeping the previous project's
          settings and captured map (GeoLibre discussion #1992). */}
      <PrintLayoutDialog
        key={`print-layout-${projectGeneration}`}
        open={printLayoutOpen}
        onOpenChange={setPrintLayoutOpen}
        mapControllerRef={mapControllerRef}
      />
      {/* Field Collection and GPS Tracking add features and layers to the
          project, so they follow the Controls menu entries that open them out
          of the read-only viewer preset. Record Tour and Record Video below
          only read the map, so they stay. */}
      {!viewer && (
        <FieldCollectionDialog
          open={fieldCollectionOpen}
          onOpenChange={setFieldCollectionOpen}
          mapControllerRef={mapControllerRef}
        />
      )}
      {!viewer && (
        <GpsTrackingDialog
          open={gpsTrackingOpen}
          onOpenChange={setGpsTrackingOpen}
          mapControllerRef={mapControllerRef}
        />
      )}
      <RecordTourDialog
        open={recordTourOpen}
        onOpenChange={setRecordTourOpen}
        mapControllerRef={mapControllerRef}
      />
      <RecordVideoDialog
        open={recordVideoOpen}
        onOpenChange={setRecordVideoOpen}
        mapControllerRef={mapControllerRef}
      />
      <GeoreferencerDialog
        open={georeferencerOpen}
        onOpenChange={setGeoreferencerOpen}
        mapControllerRef={mapControllerRef}
      />
      <SetViewDialog
        open={setViewOpen}
        onOpenChange={setSetViewOpen}
        mapControllerRef={mapControllerRef}
      />
      <LoadFeaturesIntoEditorDialog
        open={loadEditorFeaturesOpen}
        onOpenChange={setLoadEditorFeaturesOpen}
        mapControllerRef={mapControllerRef}
        initialLayerId={loadEditorFeaturesLayerId}
      />
      <ShareProjectDialog
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
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
      <ProjectGalleryDialog
        open={galleryDialogOpen}
        onOpenChange={setGalleryDialogOpen}
        onOpenProject={(url, authToken) => projectFiles.openProjectFromShareUrl(url, { authToken })}
      />
      {isMenuVisible(uiProfile, "help") && (
        <HelpMenu
          chrome={chrome}
          viewer={viewer}
          diagnosticsErrorCount={diagnosticsErrorCount}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onOpenDiagnostics={onOpenDiagnostics}
          onCheckForUpdates={() => {
            setAboutOpen(true);
            setCheckForUpdatesRequest((value) => value + 1);
          }}
          onAbout={() => setAboutOpen(true)}
        />
      )}
      {/* External plugin toolbar menus render after Help so third-party menus
          sit at the end of the banner, past the built-in menus. */}
      {!viewer ? <PluginToolbarMenus chrome={chrome} placement="external" /> : null}
      <AddDataDialog
        kind={addDataKind}
        mapControllerRef={mapControllerRef}
        initialDeckVizKind={addDataDeckVizKind}
        initialPostgres={addDataPostgres}
        initialUrl={addDataKind === initialService?.kind ? initialService.url : undefined}
        initialLayer={
          addDataKind === initialService?.kind ? (initialService.layer ?? undefined) : undefined
        }
        initialStyleUrl={
          addDataKind === initialService?.kind ? (initialService.styleUrl ?? undefined) : undefined
        }
        onOpenChange={(open: boolean) => {
          if (!open) {
            if (addDataTargetGroupId) {
              const state = useAppStore.getState();
              const addedIds = state.layers
                .filter((layer) => !addDataInitialLayerIdsRef.current.has(layer.id))
                .map((layer) => layer.id);
              if (addedIds.length > 0) {
                state.moveLayersToGroup(addedIds, addDataTargetGroupId);
              }
            }
            setAddDataKind(null);
            setInitialService(null);
            setAddDataTargetGroupId(null);
            setAddDataDeckVizKind(undefined);
            setAddDataPostgres(undefined);
          }
        }}
      />
      <AddNetcdfDialog open={netcdfDialogOpen} appApi={appApi} onOpenChange={setNetcdfDialogOpen} />
      <ProjectFileDialogs projectFiles={projectFiles} />
      <ConsentNoticeDialogs consent={consent} />
      <OsmPbfDialogs osmPbf={osmPbf} />
      <AboutDialog
        checkForUpdatesRequest={checkForUpdatesRequest}
        open={aboutOpen}
        renderTrigger={false}
        onOpenChange={setAboutOpen}
      />
      {!viewer && (
        <CommandPalette
          open={commandPaletteOpen}
          commands={commands}
          onOpenChange={setCommandPaletteOpen}
        />
      )}
      {!viewer && (
        <KeyboardShortcutsDialog
          open={shortcutsOpen}
          commands={commands}
          onOpenChange={setShortcutsOpen}
        />
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
