import { useAppStore } from "@geolibre/core";
import { BASEMAP_CONTROL_PLUGIN_ID, GEO_EDITOR_PLUGIN_ID } from "@geolibre/plugins";
import { BottomSheet } from "@geolibre/ui";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ThemeMode } from "../../../hooks/useThemeMode";
import { useDesktopSettingsStore } from "../../../hooks/useDesktopSettings";
import type { ProjectFileActions } from "../../../hooks/useProjectFileActions";
import type { ToolbarDialogs } from "../../../hooks/toolbar/useToolbarDialogs";
import { IS_MAS_BUILD } from "../../../lib/build-flags";
import { entryMenuOffered } from "../../../lib/deployment-gates";
import { isDataSourceVisible, isMenuVisible, isPluginVisible } from "../../../lib/ui-profile";
import type { AddDataKind } from "../AddDataDialog";
import { openSettingsSection } from "../SettingsDialog";
import type { AddLayerHandlers, AppApi } from "../toolbar/constants";
import type { MobileNavTabId } from "./MobileBottomNav";
import {
  MobileAddSheetContent,
  MobileFieldSheetContent,
  MobileMoreSheetContent,
} from "./MobileQuickSheets";
import { MobileTopBar } from "./MobileTopBar";

export interface MobileToolbarChromeProps {
  title: string;
  viewer: boolean;
  addDataReady: boolean;
  themeMode: ThemeMode;
  diagnosticsErrorCount: number;
  shareAvailable: boolean;
  measureVisible: boolean;
  measureSupported: boolean;
  onToggleMeasure: () => void;
  activeMobileTab: MobileNavTabId | null;
  onSelectMobileTab?: (tab: MobileNavTabId | null) => void;
  mobileSheetHostEl: HTMLDivElement | null;
  appApi: AppApi;
  isPluginActive: (id: string) => boolean;
  togglePlugin: (id: string, appApi: AppApi) => void;
  addLayer: AddLayerHandlers;
  openAddDataKind: (kind: AddDataKind) => void;
  dialogs: ToolbarDialogs;
  projectFiles: ProjectFileActions;
  onToggleThemeMode: () => void;
  onOpenBasemapExtract: () => void;
  onAddComment: () => void;
  onOpenDiagnostics: () => void;
}

/**
 * Renders the compact {@link MobileTopBar} and portals the Add / Field / More
 * {@link BottomSheet} quick sheets into the workspace container so they sit
 * cleanly above the bottom navigation bar.
 */
export function MobileToolbarChrome({
  title,
  viewer,
  addDataReady,
  themeMode,
  diagnosticsErrorCount,
  shareAvailable,
  measureVisible,
  measureSupported,
  onToggleMeasure,
  activeMobileTab,
  onSelectMobileTab,
  mobileSheetHostEl,
  appApi,
  isPluginActive,
  togglePlugin,
  addLayer,
  openAddDataKind,
  dialogs,
  projectFiles,
  onToggleThemeMode,
  onOpenBasemapExtract,
  onAddComment,
  onOpenDiagnostics,
}: MobileToolbarChromeProps) {
  const { t } = useTranslation();
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  const deploymentCapabilities = useAppStore((s) => s.deploymentCapabilities);

  const canAddData = entryMenuOffered("addData", {
    viewer,
    capabilities: deploymentCapabilities,
    menuVisible: isMenuVisible(uiProfile, "addData"),
  });
  const canOpenBasemaps =
    entryMenuOffered("plugins", {
      viewer,
      capabilities: deploymentCapabilities,
      menuVisible: isMenuVisible(uiProfile, "plugins"),
    }) && isPluginVisible(uiProfile, BASEMAP_CONTROL_PLUGIN_ID);
  const canRunProcessing =
    !viewer &&
    isMenuVisible(uiProfile, "processing") &&
    deploymentCapabilities.has("processing:run");
  const canManageSettings = !viewer && deploymentCapabilities.has("settings:manage");
  const canManagePlugins =
    !IS_MAS_BUILD && !viewer && deploymentCapabilities.has("plugins:install");

  const runMobileAction = (action: () => void) => {
    onSelectMobileTab?.(null);
    action();
  };

  const switchToDesktopUi = () => {
    const { desktopSettings, setDesktopSettings } = useDesktopSettingsStore.getState();
    setDesktopSettings({
      ...desktopSettings,
      layout: { ...desktopSettings.layout, touchUiMode: "desktop" },
    });
  };

  const mobileQuickSheetOpen =
    activeMobileTab === "add" || activeMobileTab === "field" || activeMobileTab === "more";
  const mobileQuickSheetTitle =
    activeMobileTab === "add"
      ? t("mobileShell.sheet.addTitle")
      : activeMobileTab === "field"
        ? t("mobileShell.sheet.fieldTitle")
        : t("mobileShell.sheet.moreTitle");

  const mobileQuickSheet =
    mobileQuickSheetOpen && mobileSheetHostEl
      ? createPortal(
          <BottomSheet
            key={activeMobileTab}
            open
            modal={activeMobileTab === "more"}
            onOpenChange={(open) => {
              if (!open) onSelectMobileTab?.(null);
            }}
            defaultDetent={activeMobileTab === "more" ? "full" : "half"}
            title={mobileQuickSheetTitle}
            closeLabel={t("common.close")}
            dragHandleLabel={t("mobileShell.resizeSheet")}
            data-testid={`mobile-sheet-${activeMobileTab}`}
          >
            {activeMobileTab === "add" ? (
              <MobileAddSheetContent
                canAddVector={isDataSourceVisible(uiProfile, "vector")}
                canAddRaster={isDataSourceVisible(uiProfile, "raster")}
                canAddDelimited={isDataSourceVisible(uiProfile, "delimited-text")}
                canAddXyz={isDataSourceVisible(uiProfile, "xyz")}
                canAddWms={isDataSourceVisible(uiProfile, "wms")}
                canAddGeoParquet={isDataSourceVisible(uiProfile, "geoparquet")}
                canOpenBasemaps={canOpenBasemaps}
                basemapsActive={isPluginActive(BASEMAP_CONTROL_PLUGIN_ID)}
                onAddVector={() => runMobileAction(addLayer.vector)}
                onAddRaster={() => runMobileAction(addLayer.raster)}
                onAddDelimited={() => runMobileAction(() => openAddDataKind("delimited-text"))}
                onAddXyz={() => runMobileAction(() => openAddDataKind("xyz"))}
                onAddWms={() => runMobileAction(() => openAddDataKind("wms"))}
                onAddGeoParquet={() => runMobileAction(addLayer.vector)}
                onToggleBasemaps={() =>
                  runMobileAction(() => togglePlugin(BASEMAP_CONTROL_PLUGIN_ID, appApi))
                }
                onOpenGallery={() => runMobileAction(() => dialogs.setGalleryDialogOpen(true))}
                onSearchAllSources={() =>
                  runMobileAction(() => dialogs.setCommandPaletteOpen(true))
                }
              />
            ) : null}
            {activeMobileTab === "field" ? (
              <MobileFieldSheetContent
                geoEditorActive={isPluginActive(GEO_EDITOR_PLUGIN_ID)}
                measureActive={measureVisible}
                measureDisabled={!measureSupported && !measureVisible}
                onOpenFieldCollection={() =>
                  runMobileAction(() => dialogs.setFieldCollectionOpen(true))
                }
                onOpenGpsTracking={() => runMobileAction(() => dialogs.setGpsTrackingOpen(true))}
                onToggleGeoEditor={() =>
                  runMobileAction(() => togglePlugin(GEO_EDITOR_PLUGIN_ID, appApi))
                }
                onToggleMeasure={() => runMobileAction(onToggleMeasure)}
                onOpenOfflineBasemap={() => runMobileAction(onOpenBasemapExtract)}
                onAddComment={() => runMobileAction(onAddComment)}
              />
            ) : null}
            {activeMobileTab === "more" ? (
              <MobileMoreSheetContent
                canEditProject={!viewer && isMenuVisible(uiProfile, "project")}
                canShare={shareAvailable}
                canRunProcessing={canRunProcessing}
                canManagePlugins={canManagePlugins}
                canManageSettings={canManageSettings}
                diagnosticsErrorCount={diagnosticsErrorCount}
                onOpenCommandPalette={() =>
                  runMobileAction(() => dialogs.setCommandPaletteOpen(true))
                }
                onNewProject={() => runMobileAction(() => dialogs.setNewProjectDialogOpen(true))}
                onOpenFromFile={() => runMobileAction(() => void projectFiles.handleOpenFromFile())}
                onOpenFromUrl={() =>
                  runMobileAction(() => projectFiles.setProjectUrlDialogOpen(true))
                }
                onSaveProject={() => runMobileAction(() => void projectFiles.handleSave())}
                onShareProject={() => runMobileAction(() => dialogs.setShareDialogOpen(true))}
                onOpenProcessing={() =>
                  runMobileAction(() => useAppStore.getState().setProcessingOpen(true))
                }
                onOpenManagePlugins={() =>
                  runMobileAction(() => dialogs.setManagePluginsOpen(true))
                }
                onOpenSettings={() => runMobileAction(() => openSettingsSection("layout"))}
                onOpenDiagnostics={() => runMobileAction(onOpenDiagnostics)}
                onSwitchToDesktopUi={() => runMobileAction(switchToDesktopUi)}
                onOpenAbout={() => runMobileAction(() => dialogs.setAboutOpen(true))}
              />
            ) : null}
          </BottomSheet>,
          mobileSheetHostEl,
        )
      : null;

  return (
    <>
      <MobileTopBar
        title={title}
        canAddData={canAddData}
        addDataReady={addDataReady}
        themeMode={themeMode}
        menuOpen={activeMobileTab === "more"}
        onToggleMenu={() => onSelectMobileTab?.(activeMobileTab === "more" ? null : "more")}
        onOpenSearch={() => runMobileAction(() => dialogs.setCommandPaletteOpen(true))}
        onOpenAdd={() => onSelectMobileTab?.(activeMobileTab === "add" ? null : "add")}
        onToggleThemeMode={onToggleThemeMode}
      />
      {mobileQuickSheet}
    </>
  );
}
