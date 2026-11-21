import { useAppStore } from "@geolibre/core";
import {
  Box,
  Bug,
  Compass,
  Cpu,
  Download,
  Eye,
  FilePlus2,
  FolderOpen,
  Info,
  LayoutGrid,
  Monitor,
  Mountain,
  Palette,
  Puzzle,
  RotateCcw,
  Save,
  Search,
  Settings,
  Share2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { TFunction } from "i18next";
import type { ParseKeys } from "i18next";
import type { Command } from "../../../lib/commands";
import { CVD_MODE_LABEL_KEYS, useCvdPreviewStore } from "../../../lib/cvd-preview-store";
import { CVD_MODES } from "../../../lib/cvd-simulation";
import type { TouchMenuItem } from "../../../lib/touch-menu-nav";
import { isMenuItemVisible } from "../../../lib/ui-profile";

type UiProfile = Parameters<typeof isMenuItemVisible>[0];

const SPLIT_VIEW_PRESETS: ReadonlyArray<{
  rows: number;
  cols: number;
  labelKey: ParseKeys;
}> = [
  { rows: 1, cols: 1, labelKey: "toolbar.item.splitViewSingle" },
  { rows: 1, cols: 2, labelKey: "toolbar.item.splitViewTwoColumns" },
  { rows: 2, cols: 1, labelKey: "toolbar.item.splitViewTwoRows" },
  { rows: 2, cols: 2, labelKey: "toolbar.item.splitViewGrid2x2" },
  { rows: 2, cols: 3, labelKey: "toolbar.item.splitViewGrid2x3" },
  { rows: 3, cols: 3, labelKey: "toolbar.item.splitViewGrid3x3" },
];

export interface BuildMobileMoreMenuOptions {
  t: TFunction;
  uiProfile: UiProfile;
  primaryRenderer: ReturnType<typeof useAppStore.getState>["primaryRenderer"];
  gridKey: string;
  cvdMode: ReturnType<typeof useCvdPreviewStore.getState>["mode"];
  canEditProject: boolean;
  canShare: boolean;
  canShowView: boolean;
  canRunProcessing: boolean;
  canManagePlugins: boolean;
  canManageSettings: boolean;
  diagnosticsErrorCount: number;
  processingCommands: readonly Command[];
  onOpenCommandPalette: () => void;
  onNewProject: () => void;
  onOpenFromFile: () => void;
  onOpenFromUrl: () => void;
  onSaveProject: () => void;
  onShareProject: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetNorth: () => void;
  onResetPitch: () => void;
  onResetPitchBearing: () => void;
  onOpenProcessing: () => void;
  onOpenManagePlugins: () => void;
  onOpenSettings: () => void;
  onOpenDiagnostics: () => void;
  onSwitchToDesktopUi: () => void;
  onOpenAbout: () => void;
}

/**
 * Builds the hierarchical touch drill-down menu tree for the phone More sheet,
 * reusing the live capability-gated `processingCommands` and view controls.
 */
export function buildMobileMoreMenuItems({
  t,
  uiProfile,
  primaryRenderer,
  gridKey,
  cvdMode,
  canEditProject,
  canShare,
  canShowView,
  canRunProcessing,
  canManagePlugins,
  canManageSettings,
  diagnosticsErrorCount,
  processingCommands,
  onOpenCommandPalette,
  onNewProject,
  onOpenFromFile,
  onOpenFromUrl,
  onSaveProject,
  onShareProject,
  onZoomIn,
  onZoomOut,
  onResetNorth,
  onResetPitch,
  onResetPitchBearing,
  onOpenProcessing,
  onOpenManagePlugins,
  onOpenSettings,
  onOpenDiagnostics,
  onSwitchToDesktopUi,
  onOpenAbout,
}: BuildMobileMoreMenuOptions): TouchMenuItem[] {
  const { setMapGrid, setPrimaryRenderer } = useAppStore.getState();
  const { setMode: setCvdMode } = useCvdPreviewStore.getState();

  const projectItems: TouchMenuItem[] = canEditProject
    ? [
        {
          kind: "action",
          id: "project-new",
          label: t("mobileShell.more.newProject"),
          icon: <FilePlus2 className="h-4 w-4" />,
          onSelect: onNewProject,
        },
        {
          kind: "action",
          id: "project-open-file",
          label: t("mobileShell.more.openFile"),
          icon: <FolderOpen className="h-4 w-4" />,
          onSelect: onOpenFromFile,
        },
        {
          kind: "action",
          id: "project-open-url",
          label: t("mobileShell.more.openUrl"),
          icon: <Download className="h-4 w-4" />,
          onSelect: onOpenFromUrl,
        },
        {
          kind: "action",
          id: "project-save",
          label: t("mobileShell.more.save"),
          icon: <Save className="h-4 w-4" />,
          onSelect: onSaveProject,
        },
        ...(canShare
          ? [
              {
                kind: "action" as const,
                id: "project-share",
                label: t("mobileShell.more.share"),
                icon: <Share2 className="h-4 w-4" />,
                onSelect: onShareProject,
              },
            ]
          : []),
      ]
    : [];

  const showViewItem = (id: string) => canShowView && isMenuItemVisible(uiProfile, id);
  // eslint-disable-next-line local/no-renderer-kind-checks -- recovery action so users can always switch back to MapLibre
  const isNonDefaultRenderer = primaryRenderer !== "maplibre";
  const showRenderingEngine = showViewItem("view.renderingEngine") || isNonDefaultRenderer;

  const viewItems: TouchMenuItem[] = [];
  if (showViewItem("view.zoomIn")) {
    viewItems.push({
      kind: "action",
      id: "view-zoom-in",
      label: t("toolbar.item.zoomIn"),
      icon: <ZoomIn className="h-4 w-4" />,
      onSelect: onZoomIn,
    });
  }
  if (showViewItem("view.zoomOut")) {
    viewItems.push({
      kind: "action",
      id: "view-zoom-out",
      label: t("toolbar.item.zoomOut"),
      icon: <ZoomOut className="h-4 w-4" />,
      onSelect: onZoomOut,
    });
  }
  if (showViewItem("view.resetNorth")) {
    viewItems.push({
      kind: "action",
      id: "view-reset-north",
      label: t("toolbar.item.resetBearing"),
      icon: <Compass className="h-4 w-4" />,
      onSelect: onResetNorth,
    });
  }
  if (showViewItem("view.resetPitch")) {
    viewItems.push({
      kind: "action",
      id: "view-reset-pitch",
      label: t("toolbar.item.resetPitch"),
      icon: <Mountain className="h-4 w-4" />,
      onSelect: onResetPitch,
    });
  }
  if (showViewItem("view.resetPitchBearing")) {
    viewItems.push({
      kind: "action",
      id: "view-reset-both",
      label: t("toolbar.item.resetPitchBearing"),
      icon: <RotateCcw className="h-4 w-4" />,
      onSelect: onResetPitchBearing,
    });
  }
  if (showViewItem("view.splitView")) {
    viewItems.push({
      kind: "submenu",
      id: "view-split",
      label: t("toolbar.item.splitView"),
      icon: <LayoutGrid className="h-4 w-4" />,
      items: SPLIT_VIEW_PRESETS.map((preset) => ({
        kind: "action" as const,
        id: `split-${preset.rows}x${preset.cols}`,
        label: t(preset.labelKey),
        active: gridKey === `${preset.rows}x${preset.cols}`,
        onSelect: () => setMapGrid(preset.rows, preset.cols),
      })),
    });
  }
  if (showViewItem("view.colorVision")) {
    viewItems.push({
      kind: "submenu",
      id: "view-cvd",
      label: t("toolbar.item.colorVisionPreview"),
      icon: <Palette className="h-4 w-4" />,
      items: [
        {
          kind: "action",
          id: "cvd-off",
          label: t("toolbar.item.cvdOff"),
          active: cvdMode === null,
          onSelect: () => setCvdMode(null),
        },
        ...CVD_MODES.map((mode) => ({
          kind: "action" as const,
          id: `cvd-${mode}`,
          label: t(CVD_MODE_LABEL_KEYS[mode]),
          active: cvdMode === mode,
          onSelect: () => setCvdMode(mode),
        })),
      ],
    });
  }
  if (showRenderingEngine) {
    viewItems.push({
      kind: "submenu",
      id: "view-renderer",
      label: t("toolbar.item.renderingEngine"),
      icon: <Box className="h-4 w-4" />,
      items: (
        [
          ["maplibre", "toolbar.item.rendererMapLibre"],
          ["mapbox", "toolbar.item.rendererMapbox"],
          ["arcgis", "toolbar.item.rendererArcgis"],
          ["cesium", "toolbar.item.rendererCesium"],
        ] as const
      ).map(([id, labelKey]) => ({
        kind: "action" as const,
        id: `renderer-${id}`,
        label: t(labelKey),
        active: primaryRenderer === id,
        onSelect: () => setPrimaryRenderer(id),
      })),
    });
  }

  // Group processing commands by their localized group name into drill-down submenus.
  const processingSubmenus: TouchMenuItem[] = [];
  if (canRunProcessing) {
    processingSubmenus.push({
      kind: "action",
      id: "processing-toolbox",
      label: t("mobileShell.more.processing"),
      icon: <Cpu className="h-4 w-4" />,
      onSelect: onOpenProcessing,
    });
    const byGroup = new Map<string, Command[]>();
    for (const cmd of processingCommands) {
      const list = byGroup.get(cmd.group) ?? [];
      list.push(cmd);
      byGroup.set(cmd.group, list);
    }
    for (const [group, cmds] of byGroup) {
      processingSubmenus.push({
        kind: "submenu",
        // Key the submenu by its first command id. Command ids are unique, so
        // localized group labels cannot collide, and the key does not shift
        // when an earlier group is removed.
        id: `proc-group-${cmds[0].id}`,
        label: group,
        badge: String(cmds.length),
        icon: <Cpu className="h-4 w-4" />,
        items: cmds.map((cmd) => {
          const Icon = cmd.icon;
          return {
            kind: "action" as const,
            id: cmd.id,
            label: cmd.title,
            description: cmd.disabledReason,
            keywords: cmd.keywords,
            disabled: Boolean(cmd.disabledReason),
            icon: Icon ? <Icon className="h-4 w-4" /> : undefined,
            onSelect: cmd.run,
          };
        }),
      });
    }
  }

  const toolsItems: TouchMenuItem[] = [];
  if (viewItems.length > 0) {
    toolsItems.push({
      kind: "submenu",
      id: "view-menu",
      label: t("toolbar.menu.view"),
      icon: <Eye className="h-4 w-4" />,
      items: viewItems,
    });
  }
  if (canRunProcessing) {
    toolsItems.push({
      kind: "submenu",
      id: "processing-menu",
      label: t("mobileShell.more.processing"),
      badge: processingCommands.length > 0 ? String(processingCommands.length) : undefined,
      icon: <Cpu className="h-4 w-4" />,
      items: processingSubmenus,
    });
  }
  if (canManagePlugins) {
    toolsItems.push({
      kind: "action",
      id: "manage-plugins",
      label: t("mobileShell.more.managePlugins"),
      icon: <Puzzle className="h-4 w-4" />,
      onSelect: onOpenManagePlugins,
    });
  }
  toolsItems.push({
    kind: "action",
    id: "command-palette",
    label: t("mobileShell.more.commandPalette"),
    icon: <Search className="h-4 w-4" />,
    onSelect: onOpenCommandPalette,
  });

  const appItems: TouchMenuItem[] = [
    ...(canManageSettings
      ? [
          {
            kind: "action" as const,
            id: "settings",
            label: t("mobileShell.more.settings"),
            icon: <Settings className="h-4 w-4" />,
            onSelect: onOpenSettings,
          },
        ]
      : []),
    {
      kind: "action",
      id: "diagnostics",
      label: t("mobileShell.more.diagnostics"),
      badge: diagnosticsErrorCount > 0 ? String(diagnosticsErrorCount) : undefined,
      icon: <Bug className="h-4 w-4" />,
      onSelect: onOpenDiagnostics,
    },
    {
      kind: "action",
      id: "switch-desktop",
      label: t("mobileShell.more.switchToDesktopUi"),
      icon: <Monitor className="h-4 w-4" />,
      onSelect: onSwitchToDesktopUi,
    },
    {
      kind: "action",
      id: "about",
      label: t("mobileShell.more.about"),
      icon: <Info className="h-4 w-4" />,
      onSelect: onOpenAbout,
    },
  ];

  return [
    {
      kind: "section",
      id: "section-project",
      label: t("mobileShell.more.project"),
      items: projectItems,
    },
    { kind: "section", id: "section-tools", label: t("mobileShell.more.tools"), items: toolsItems },
    { kind: "section", id: "section-app", label: t("mobileShell.more.app"), items: appItems },
  ];
}
