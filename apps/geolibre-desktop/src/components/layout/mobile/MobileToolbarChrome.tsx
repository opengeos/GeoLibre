import { useAppStore } from "@geolibre/core";
import { BASEMAP_CONTROL_PLUGIN_ID, GEO_EDITOR_PLUGIN_ID } from "@geolibre/plugins";
import { BottomSheet } from "@geolibre/ui";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ThemeMode } from "../../../hooks/useThemeMode";
import { setTouchUiMode, useDesktopSettingsStore } from "../../../hooks/useDesktopSettings";
import type { ProjectFileActions } from "../../../hooks/useProjectFileActions";
import type { ToolbarDialogs } from "../../../hooks/toolbar/useToolbarDialogs";
import { IS_MAS_BUILD } from "../../../lib/build-flags";
import type { Command } from "../../../lib/commands";
import { entryMenuOffered } from "../../../lib/deployment-gates";
import { useFieldCrosshairStore } from "../../../lib/field-crosshair";
import { isDataSourceVisible, isMenuVisible, isPluginVisible } from "../../../lib/ui-profile";
import type { AddDataKind } from "../AddDataDialog";
import { openSettingsSection } from "../SettingsDialog";
import type { AddLayerHandlers, AppApi } from "../toolbar/constants";
import { buildMobileMoreMenuItems } from "./buildMobileMoreMenuItems";
import type { MobileNavTabId } from "./MobileBottomNav";
import { MobileAddSheetContent, MobileFieldSheetContent } from "./MobileQuickSheets";
import { MobileTopBar } from "./MobileTopBar";
import { TouchMenuSheet } from "./TouchMenuSheet";

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
  processingCommands: readonly Command[];
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetNorth: () => void;
  onResetPitch: () => void;
  onResetPitchBearing: () => void;
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
  processingCommands,
  onZoomIn,
  onZoomOut,
  onResetNorth,
  onResetPitch,
  onResetPitchBearing,
}: MobileToolbarChromeProps) {
  const { t } = useTranslation();
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  const deploymentCapabilities = useAppStore((s) => s.deploymentCapabilities);
  const crosshairActive = useFieldCrosshairStore((s) => s.active);

  const canAddData = entryMenuOffered("addData", {
    viewer,
    capabilities: deploymentCapabilities,
    menuVisible: isMenuVisible(uiProfile, "addData"),
  });
  const canOpenPluginsMenu = entryMenuOffered("plugins", {
    viewer,
    capabilities: deploymentCapabilities,
    menuVisible: isMenuVisible(uiProfile, "plugins"),
  });
  const canOpenBasemaps =
    canOpenPluginsMenu && isPluginVisible(uiProfile, BASEMAP_CONTROL_PLUGIN_ID);
  const canUseGeoEditor = canOpenPluginsMenu && isPluginVisible(uiProfile, GEO_EDITOR_PLUGIN_ID);
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
    setTouchUiMode("desktop");
  };

  const mobileQuickSheetOpen = activeMobileTab === "add" || activeMobileTab === "field";
  const mobileQuickSheetTitle =
    activeMobileTab === "add" ? t("mobileShell.sheet.addTitle") : t("mobileShell.sheet.fieldTitle");

  const moreMenuItems =
    activeMobileTab === "more"
      ? buildMobileMoreMenuItems({
          t,
          canEditProject: !viewer && isMenuVisible(uiProfile, "project"),
          canShare: shareAvailable,
          canShowView: isMenuVisible(uiProfile, "view"),
          canRunProcessing,
          canManagePlugins,
          canManageSettings,
          diagnosticsErrorCount,
          processingCommands,
          onOpenCommandPalette: () => dialogs.setCommandPaletteOpen(true),
          onNewProject: () => dialogs.setNewProjectDialogOpen(true),
          onOpenFromFile: () => void projectFiles.handleOpenFromFile(),
          onOpenFromUrl: () => projectFiles.setProjectUrlDialogOpen(true),
          onSaveProject: () => void projectFiles.handleSave(),
          onShareProject: () => dialogs.setShareDialogOpen(true),
          onZoomIn,
          onZoomOut,
          onResetNorth,
          onResetPitch,
          onResetPitchBearing,
          onOpenProcessing: () => useAppStore.getState().setProcessingOpen(true),
          onOpenManagePlugins: () => dialogs.setManagePluginsOpen(true),
          onOpenSettings: () => openSettingsSection("layout"),
          onOpenDiagnostics,
          onSwitchToDesktopUi: switchToDesktopUi,
          onOpenAbout: () => dialogs.setAboutOpen(true),
        })
      : [];

  const mobileQuickSheet =
    activeMobileTab === "more" && mobileSheetHostEl
      ? createPortal(
          <TouchMenuSheet
            open
            onOpenChange={(open) => {
              if (!open) onSelectMobileTab?.(null);
            }}
            title={t("mobileShell.sheet.moreTitle")}
            items={moreMenuItems}
            defaultDetent="full"
            modal
            searchable
            searchPlaceholder={t("mobileShell.menu.searchPlaceholder")}
            data-testid="mobile-sheet-more"
          />,
          mobileSheetHostEl,
        )
      : mobileQuickSheetOpen && mobileSheetHostEl
        ? createPortal(
            <BottomSheet
              key={activeMobileTab}
              open
              onOpenChange={(open) => {
                if (!open) onSelectMobileTab?.(null);
              }}
              defaultDetent="half"
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
                  canUseGeoEditor={canUseGeoEditor}
                  crosshairActive={crosshairActive}
                  geoEditorActive={isPluginActive(GEO_EDITOR_PLUGIN_ID)}
                  measureActive={measureVisible}
                  measureDisabled={!measureSupported && !measureVisible}
                  onStartCrosshairCapture={() =>
                    runMobileAction(() => {
                      const store = useFieldCrosshairStore.getState();
                      if (store.active) store.stop();
                      else store.start();
                    })
                  }
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
