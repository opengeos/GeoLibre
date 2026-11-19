import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { collapseRightPanel, openRasterLayerPanel } from "@geolibre/plugins";
import { BottomSheet } from "@geolibre/ui";
import {
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { CollaborationApi } from "../../../hooks/useCollaboration";
import type { LayoutOptions } from "../../../hooks/useLayoutOptions";
import { useFloatingPanels } from "../../../hooks/usePluginUiSurfaces";
import { createAppAPI } from "../../../hooks/usePlugins";
import { useRightPanelState } from "../../../hooks/useRightPanels";
import type { ThemeMode } from "../../../hooks/useThemeMode";
import type { GeoLibreLayer } from "@geolibre/core";
import { SectionErrorBoundary } from "../../common/error-boundaries";
import { LayerPanel } from "../../panels/LayerPanel";
import { StylePanel } from "../../panels/StylePanel";
import type { MobileNavTabId } from "./MobileBottomNav";
import { MobilePluginSheet } from "./MobilePluginSheet";

/**
 * Coordinates the single-sheet state machine for the phone mobile shell:
 * keeps the bottom-nav tabs, expanded plugin right panels, and bottom panels
 * mutually exclusive and tracks whether any sheet is obscuring the map.
 */
export function useMobileShellState(mobileShell: boolean) {
  const [activeMobileTab, setActiveMobileTab] = useState<MobileNavTabId | null>(null);
  const [mobileSheetHostEl, setMobileSheetHostEl] = useState<HTMLDivElement | null>(null);
  const rightPanelState = useRightPanelState();
  const expandedPluginPanelId =
    rightPanelState.activeId !== null && !rightPanelState.collapsed
      ? rightPanelState.activeId
      : null;
  const { openIds: floatingPanelOpenIds } = useFloatingPanels();
  const anyBottomPanelOpen = useAppStore(
    (s) =>
      s.ui.attributeTableOpen ||
      s.ui.rasterAttributeTableOpen ||
      s.ui.dashboardOpen ||
      s.ui.pythonConsoleOpen ||
      s.ui.sqlWorkspaceOpen ||
      s.ui.assistantOpen,
  );

  const closeAllBottomPanels = useCallback(() => {
    const store = useAppStore.getState();
    if (store.ui.attributeTableOpen) store.setAttributeTableOpen(false);
    if (store.ui.rasterAttributeTableOpen) store.setRasterAttributeTableOpen(false);
    if (store.ui.dashboardOpen) store.setDashboardOpen(false);
    if (store.ui.pythonConsoleOpen) store.setPythonConsoleOpen(false);
    if (store.ui.sqlWorkspaceOpen) store.setSqlWorkspaceOpen(false);
    if (store.ui.assistantOpen) store.setAssistantOpen(false);
  }, []);

  const prevMobileShellRef = useRef(false);
  const prevExpandedPluginRef = useRef<string | null>(null);
  const prevBottomPanelOpenRef = useRef(false);

  useEffect(() => {
    const enteredMobileShell = mobileShell && !prevMobileShellRef.current;
    const pluginJustExpanded =
      expandedPluginPanelId !== null && expandedPluginPanelId !== prevExpandedPluginRef.current;
    const bottomJustOpened = anyBottomPanelOpen && !prevBottomPanelOpenRef.current;

    prevMobileShellRef.current = mobileShell;
    prevExpandedPluginRef.current = expandedPluginPanelId;
    prevBottomPanelOpenRef.current = anyBottomPanelOpen;

    if (!mobileShell) {
      setActiveMobileTab(null);
      return;
    }

    if (enteredMobileShell && anyBottomPanelOpen && expandedPluginPanelId) {
      setActiveMobileTab(null);
      collapseRightPanel(expandedPluginPanelId);
      return;
    }

    if (bottomJustOpened) {
      setActiveMobileTab(null);
      if (expandedPluginPanelId) collapseRightPanel(expandedPluginPanelId);
      return;
    }

    if (pluginJustExpanded) {
      setActiveMobileTab(null);
      if (anyBottomPanelOpen) closeAllBottomPanels();
    }
  }, [mobileShell, expandedPluginPanelId, anyBottomPanelOpen, closeAllBottomPanels]);

  const openMobileTab = useCallback(
    (tab: MobileNavTabId) => {
      if (expandedPluginPanelId) collapseRightPanel(expandedPluginPanelId);
      if (anyBottomPanelOpen) closeAllBottomPanels();
      setActiveMobileTab(tab);
    },
    [expandedPluginPanelId, anyBottomPanelOpen, closeAllBottomPanels],
  );

  const closeMobileTab = useCallback(() => {
    setActiveMobileTab(null);
  }, []);

  const handleSelectMobileTab = useCallback(
    (tab: MobileNavTabId | null) => {
      if (tab === null || activeMobileTab === tab) {
        closeMobileTab();
        return;
      }
      openMobileTab(tab);
    },
    [activeMobileTab, closeMobileTab, openMobileTab],
  );

  const anyMobileSheetOpen =
    mobileShell &&
    (activeMobileTab !== null ||
      expandedPluginPanelId !== null ||
      anyBottomPanelOpen ||
      floatingPanelOpenIds.length > 0);

  return {
    activeMobileTab,
    openMobileTab,
    closeMobileTab,
    handleSelectMobileTab,
    mobileSheetHostEl,
    setMobileSheetHostEl,
    expandedPluginPanelId,
    anyBottomPanelOpen,
    anyMobileSheetOpen,
    closeAllBottomPanels,
  };
}

export interface MobileShellSheetsProps {
  activeMobileTab: MobileNavTabId | null;
  onOpenMobileTab: (tab: MobileNavTabId) => void;
  onCloseMobileTab: () => void;
  expandedPluginPanelId: string | null;
  anyBottomPanelOpen: boolean;
  onCloseBottomPanels: () => void;
  dockContentEl: HTMLElement;
  layoutOptions: LayoutOptions;
  themeMode: ThemeMode;
  mapControllerRef: RefObject<MapEngine | null>;
  mapReadyGeneration: number;
  collaboration: CollaborationApi;
  layerRefresh: ComponentProps<typeof LayerPanel>["refresh"];
  geometryEditLayerId: string | null;
  onToggleGeometryEdit: (layerId: string) => void;
  onCancelGeometryEdit: () => void;
  onMaterializeDuckDBLayer: (layer: GeoLibreLayer) => void;
  onOpenStylePanel: () => void;
  onOpenRasterSubset: (layer: GeoLibreLayer) => void;
  startLayerPanelResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  startStylePanelResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  stylePanelOpenRequest: number;
  notebookOpen: boolean;
  storymapPresenting: boolean;
  bottomPanels: ReactNode;
}

/**
 * Renders the unified BottomSheet hosts for Layers, Style, active plugin right
 * panels, and docked bottom panels (Attribute Table, Assistant, SQL, Dashboard)
 * when the phone mobile shell is active.
 */
export function MobileShellSheets({
  activeMobileTab,
  onOpenMobileTab,
  onCloseMobileTab,
  expandedPluginPanelId,
  anyBottomPanelOpen,
  onCloseBottomPanels,
  dockContentEl,
  layoutOptions,
  themeMode,
  mapControllerRef,
  mapReadyGeneration,
  collaboration,
  layerRefresh,
  geometryEditLayerId,
  onToggleGeometryEdit,
  onCancelGeometryEdit,
  onMaterializeDuckDBLayer,
  onOpenStylePanel,
  onOpenRasterSubset,
  startLayerPanelResize,
  startStylePanelResize,
  stylePanelOpenRequest,
  notebookOpen,
  storymapPresenting,
  bottomPanels,
}: MobileShellSheetsProps) {
  const { t } = useTranslation();

  return (
    <>
      {layoutOptions.layerPanelVisible ? (
        <BottomSheet
          open={activeMobileTab === "layers"}
          onOpenChange={(open) => {
            if (!open) onCloseMobileTab();
          }}
          defaultDetent="half"
          hideHeader
          ariaLabel={t("sharedRail.layers")}
          closeLabel={t("common.close")}
          dragHandleLabel={t("mobileShell.resizeSheet")}
          bodyClassName="overflow-hidden"
          data-testid="mobile-sheet-layers"
        >
          <SectionErrorBoundary label="Layer panel" displayName={t("shell.section.layerPanel")}>
            <LayerPanel
              refresh={layerRefresh}
              themeMode={themeMode}
              mapControllerRef={mapControllerRef}
              collaborationApi={collaboration}
              onResizeStart={startLayerPanelResize}
              geometryEditLayerId={geometryEditLayerId}
              onToggleGeometryEdit={onToggleGeometryEdit}
              onCancelGeometryEdit={onCancelGeometryEdit}
              onMaterializeDuckDBLayer={onMaterializeDuckDBLayer}
              onOpenRasterStylePanel={() => openRasterLayerPanel(createAppAPI(mapControllerRef))}
              onOpenStylePanel={layoutOptions.stylePanelVisible ? onOpenStylePanel : undefined}
              onOpenRasterSubset={onOpenRasterSubset}
              collapsed={activeMobileTab !== "layers"}
              onCollapsedChange={(collapsed) => {
                if (collapsed) onCloseMobileTab();
                else onOpenMobileTab("layers");
              }}
              hideOwnRail
            />
          </SectionErrorBoundary>
        </BottomSheet>
      ) : null}
      {layoutOptions.stylePanelVisible ? (
        <BottomSheet
          open={activeMobileTab === "style"}
          onOpenChange={(open) => {
            if (!open) onCloseMobileTab();
          }}
          defaultDetent="half"
          hideHeader
          ariaLabel={t("sharedRail.style")}
          closeLabel={t("common.close")}
          dragHandleLabel={t("mobileShell.resizeSheet")}
          bodyClassName="overflow-hidden"
          data-testid="mobile-sheet-style"
        >
          <SectionErrorBoundary label="Style panel" displayName={t("shell.section.stylePanel")}>
            <StylePanel
              mapControllerRef={mapControllerRef}
              mapReadyGeneration={mapReadyGeneration}
              onResizeStart={startStylePanelResize}
              openRequest={stylePanelOpenRequest}
              collapsed={activeMobileTab !== "style"}
              onCollapsedChange={(collapsed) => {
                if (collapsed) onCloseMobileTab();
                else onOpenMobileTab("style");
              }}
              autoCollapse={notebookOpen || storymapPresenting}
              hideOwnRail
            />
          </SectionErrorBoundary>
        </BottomSheet>
      ) : null}
      <MobilePluginSheet activePanelId={expandedPluginPanelId} contentEl={dockContentEl} />
      {anyBottomPanelOpen ? (
        <BottomSheet
          open
          onOpenChange={(open) => {
            if (!open) onCloseBottomPanels();
          }}
          defaultDetent="half"
          hideHeader
          ariaLabel={t("mobileShell.sheet.bottomPanelTitle")}
          closeLabel={t("common.close")}
          dragHandleLabel={t("mobileShell.resizeSheet")}
          bodyClassName="flex flex-col overflow-hidden"
          data-testid="mobile-sheet-bottom-panels"
        >
          {bottomPanels}
        </BottomSheet>
      ) : null}
    </>
  );
}
