import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { closeFloatingPanel, collapseRightPanel, openRasterLayerPanel } from "@geolibre/plugins";
import { BottomSheet } from "@geolibre/ui";
import {
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { registerMobileBackHandler } from "../../../lib/mobile-back-stack";
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

  const closeAllFloatingPanels = useCallback(() => {
    for (const id of floatingPanelOpenIds) {
      closeFloatingPanel(id);
    }
  }, [floatingPanelOpenIds]);

  const floatingPanelCount = floatingPanelOpenIds.length;
  const prevMobileShellRef = useRef(false);
  const prevExpandedPluginRef = useRef<string | null>(null);
  const prevBottomPanelOpenRef = useRef(false);
  const prevFloatingCountRef = useRef(0);

  useEffect(() => {
    const enteredMobileShell = mobileShell && !prevMobileShellRef.current;
    const pluginJustExpanded =
      expandedPluginPanelId !== null && expandedPluginPanelId !== prevExpandedPluginRef.current;
    const bottomJustOpened = anyBottomPanelOpen && !prevBottomPanelOpenRef.current;
    const floatingJustOpened = floatingPanelCount > prevFloatingCountRef.current;

    prevMobileShellRef.current = mobileShell;
    prevExpandedPluginRef.current = expandedPluginPanelId;
    prevBottomPanelOpenRef.current = anyBottomPanelOpen;
    prevFloatingCountRef.current = floatingPanelCount;

    if (!mobileShell) {
      setActiveMobileTab(null);
      return;
    }

    if (enteredMobileShell) {
      if (anyBottomPanelOpen) {
        setActiveMobileTab(null);
        if (expandedPluginPanelId) collapseRightPanel(expandedPluginPanelId);
        if (floatingPanelCount > 0) closeAllFloatingPanels();
      } else if (expandedPluginPanelId && floatingPanelCount > 0) {
        setActiveMobileTab(null);
        closeAllFloatingPanels();
      }
      return;
    }

    if (floatingJustOpened) {
      setActiveMobileTab(null);
      if (expandedPluginPanelId) collapseRightPanel(expandedPluginPanelId);
      if (anyBottomPanelOpen) closeAllBottomPanels();
      return;
    }

    if (bottomJustOpened) {
      setActiveMobileTab(null);
      if (expandedPluginPanelId) collapseRightPanel(expandedPluginPanelId);
      if (floatingPanelCount > 0) closeAllFloatingPanels();
      return;
    }

    if (pluginJustExpanded) {
      setActiveMobileTab(null);
      if (anyBottomPanelOpen) closeAllBottomPanels();
      if (floatingPanelCount > 0) closeAllFloatingPanels();
    }
  }, [
    mobileShell,
    expandedPluginPanelId,
    anyBottomPanelOpen,
    floatingPanelCount,
    closeAllBottomPanels,
    closeAllFloatingPanels,
  ]);

  const openMobileTab = useCallback(
    (tab: MobileNavTabId) => {
      if (expandedPluginPanelId) collapseRightPanel(expandedPluginPanelId);
      if (anyBottomPanelOpen) closeAllBottomPanels();
      if (floatingPanelCount > 0) closeAllFloatingPanels();
      setActiveMobileTab(tab);
    },
    [
      expandedPluginPanelId,
      anyBottomPanelOpen,
      floatingPanelCount,
      closeAllBottomPanels,
      closeAllFloatingPanels,
    ],
  );

  const closeMobileTab = useCallback(() => {
    setActiveMobileTab(null);
  }, []);

  const backStateRef = useRef({
    floatingPanelCount,
    activeMobileTab,
    expandedPluginPanelId,
    anyBottomPanelOpen,
    closeAllFloatingPanels,
    closeMobileTab,
    closeAllBottomPanels,
  });
  backStateRef.current = {
    floatingPanelCount,
    activeMobileTab,
    expandedPluginPanelId,
    anyBottomPanelOpen,
    closeAllFloatingPanels,
    closeMobileTab,
    closeAllBottomPanels,
  };

  useEffect(() => {
    if (!mobileShell) return;
    return registerMobileBackHandler(() => {
      const state = backStateRef.current;
      if (state.floatingPanelCount > 0) {
        state.closeAllFloatingPanels();
        return true;
      }
      if (state.activeMobileTab !== null) {
        state.closeMobileTab();
        return true;
      }
      if (state.expandedPluginPanelId) {
        collapseRightPanel(state.expandedPluginPanelId);
        return true;
      }
      if (state.anyBottomPanelOpen) {
        state.closeAllBottomPanels();
        return true;
      }
      return false;
    });
  }, [mobileShell]);

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

  return {
    activeMobileTab,
    openMobileTab,
    closeMobileTab,
    handleSelectMobileTab,
    mobileSheetHostEl,
    setMobileSheetHostEl,
    expandedPluginPanelId,
    anyBottomPanelOpen,
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
 * Wraps a controlled desktop panel (`LayerPanel`, `StylePanel`) inside a
 * keepMounted mobile `BottomSheet`, preserving vertical scroll offsets across
 * tab switches even when the panel returns `null` while collapsed.
 */
function MobilePanelHost({ active, children }: { active: boolean; children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const savedScrollRef = useRef<number[]>([]);

  useLayoutEffect(() => {
    if (!active) return;
    const host = hostRef.current;
    if (!host || savedScrollRef.current.length === 0) return;
    const scrollers = host.querySelectorAll<HTMLElement>(".overflow-y-auto, .overflow-auto");
    scrollers.forEach((el, index) => {
      const top = savedScrollRef.current[index];
      if (typeof top === "number" && top > 0) el.scrollTop = top;
    });
  }, [active]);

  const handleScrollCapture = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const scrollers = host.querySelectorAll<HTMLElement>(".overflow-y-auto, .overflow-auto");
    savedScrollRef.current = Array.from(scrollers, (el) => el.scrollTop);
  }, []);

  return (
    <div
      ref={hostRef}
      data-mobile-panel-host=""
      onScrollCapture={handleScrollCapture}
      className="flex min-h-0 flex-1 flex-col"
    >
      {children}
    </div>
  );
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
          keepMounted
          onOpenChange={(open) => {
            if (!open) onCloseMobileTab();
          }}
          defaultDetent="half"
          hideHeader
          ariaLabel={t("sharedRail.layers")}
          closeLabel={t("common.close")}
          dragHandleLabel={t("mobileShell.resizeSheet")}
          bodyClassName="flex flex-col overflow-hidden"
          data-testid="mobile-sheet-layers"
        >
          <MobilePanelHost active={activeMobileTab === "layers"}>
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
          </MobilePanelHost>
        </BottomSheet>
      ) : null}
      {layoutOptions.stylePanelVisible ? (
        <BottomSheet
          open={activeMobileTab === "style"}
          keepMounted
          onOpenChange={(open) => {
            if (!open) onCloseMobileTab();
          }}
          defaultDetent="half"
          hideHeader
          ariaLabel={t("sharedRail.style")}
          closeLabel={t("common.close")}
          dragHandleLabel={t("mobileShell.resizeSheet")}
          bodyClassName="flex flex-col overflow-hidden"
          data-testid="mobile-sheet-style"
        >
          <MobilePanelHost active={activeMobileTab === "style"}>
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
          </MobilePanelHost>
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
