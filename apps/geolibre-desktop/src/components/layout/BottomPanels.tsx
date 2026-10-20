import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { Suspense, type ComponentProps, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { SectionErrorBoundary } from "../common/error-boundaries";
import { AttributeTable } from "../panels/AttributeTable";
import { RasterAttributeTable } from "../panels/RasterAttributeTable";
import {
  AssistantPanel,
  DashboardPanel,
  PythonConsolePanel,
  SqlWorkspacePanel,
} from "./desktopShellLazyPanels";

interface BottomPanelsProps {
  /** Whether the attribute tables may mount (hidden in embeds and the viewer). */
  attributePanelVisible: boolean;
  mapControllerRef: RefObject<MapEngine | null>;
  /** The layer panel's refresh state, shared with the attribute table. */
  layerRefresh: ComponentProps<typeof AttributeTable>["refresh"];
}

/**
 * The panels docked along the bottom of the workspace: the attribute tables,
 * dashboard, Python console, SQL workspace, and AI Assistant. DesktopShell
 * renders them inside the map column by default (`bottomPanelsUnderMap`), so
 * the side docks keep their full height, or across the whole window when the
 * setting is off (#3157).
 *
 * Args:
 *   props: The attribute-table gate, the map controller ref, and the layer
 *     refresh state.
 *
 * Returns:
 *   The open bottom panels, stacked top to bottom.
 */
export function BottomPanels({
  attributePanelVisible,
  mapControllerRef,
  layerRefresh,
}: BottomPanelsProps) {
  const { t } = useTranslation();
  const pythonConsoleOpen = useAppStore((s) => s.ui.pythonConsoleOpen);
  const setPythonConsoleOpen = useAppStore((s) => s.setPythonConsoleOpen);
  const sqlWorkspaceOpen = useAppStore((s) => s.ui.sqlWorkspaceOpen);
  const setSqlWorkspaceOpen = useAppStore((s) => s.setSqlWorkspaceOpen);
  const assistantOpen = useAppStore((s) => s.ui.assistantOpen);
  const dashboardOpen = useAppStore((s) => s.ui.dashboardOpen);

  return (
    <>
      {attributePanelVisible ? (
        <SectionErrorBoundary
          label="Attribute table"
          displayName={t("shell.section.attributeTable")}
        >
          <AttributeTable mapControllerRef={mapControllerRef} refresh={layerRefresh} />
        </SectionErrorBoundary>
      ) : null}
      {attributePanelVisible ? (
        <SectionErrorBoundary
          label="Raster attribute table"
          displayName={t("shell.section.rasterAttributeTable")}
        >
          <RasterAttributeTable />
        </SectionErrorBoundary>
      ) : null}
      {dashboardOpen ? (
        <SectionErrorBoundary label="Dashboard" displayName={t("shell.section.dashboard")}>
          <Suspense fallback={null}>
            <DashboardPanel />
          </Suspense>
        </SectionErrorBoundary>
      ) : null}
      {pythonConsoleOpen ? (
        <SectionErrorBoundary
          label="Python console"
          displayName={t("shell.section.pythonConsole")}
          onClose={() => setPythonConsoleOpen(false)}
        >
          <Suspense fallback={null}>
            <PythonConsolePanel mapControllerRef={mapControllerRef} />
          </Suspense>
        </SectionErrorBoundary>
      ) : null}
      {sqlWorkspaceOpen ? (
        <SectionErrorBoundary
          label="SQL workspace"
          displayName={t("shell.section.sqlWorkspace")}
          onClose={() => setSqlWorkspaceOpen(false)}
        >
          <Suspense fallback={null}>
            <SqlWorkspacePanel />
          </Suspense>
        </SectionErrorBoundary>
      ) : null}
      {assistantOpen ? (
        <SectionErrorBoundary label="Assistant" displayName={t("shell.section.assistant")}>
          <Suspense fallback={null}>
            <AssistantPanel mapControllerRef={mapControllerRef} />
          </Suspense>
        </SectionErrorBoundary>
      ) : null}
    </>
  );
}
