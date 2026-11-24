/** Implementation-free host registries and plugin contracts. */
export {
  registerAssistantTool,
  registerAssistantToolSpec,
  registerAssistantGuidance,
  listAssistantTools,
  listAssistantToolEntries,
  listAssistantGuidance,
  getAssistantToolsVersion,
  unregisterAssistantToolsByOwner,
  MAX_ASSISTANT_GUIDANCE_LENGTH,
  type AssistantGuidanceEntry,
  type AssistantToolEntry,
} from "./assistant-tool-registry";
export * from "./types";
export { PluginManager } from "./plugin-manager";
export {
  registerRightPanel,
  unregisterRightPanel,
  unregisterRightPanelsByOwner,
  openRightPanel,
  collapseRightPanel,
  closeRightPanel,
  getActiveRightPanel,
  setActiveRightPanelDock,
  moveActiveRightPanelDock,
  getActiveRightPanelDock,
  RIGHT_PANEL_DOCKS,
  isRightPanelCollapsed,
  isRightPanelVisible,
  getRightPanel,
  listRightPanels,
  getRightPanelSnapshot,
  subscribeRightPanels,
  type RightPanelSnapshot,
  type RightPanelDock,
} from "./right-panel-registry";
export {
  registerToolbarMenu,
  unregisterToolbarMenu,
  unregisterToolbarMenusByOwner,
  listToolbarMenus,
  getToolbarMenusSnapshot,
  subscribeToolbarMenus,
  type ToolbarMenusSnapshot,
  type ToolbarMenuEntry,
} from "./toolbar-menu-registry";
export {
  registerMenuContribution,
  unregisterMenuContribution,
  listMenuContributions,
  getMenuContributionsSnapshot,
  subscribeMenuContributions,
  isMenuContributionTarget,
  type MenuContributionsSnapshot,
  type MenuContributionEntry,
} from "./menu-contribution-registry";
export {
  registerFileHandler,
  unregisterFileHandler,
  listFileHandlers,
  findFileHandlerByDataType,
  isFileHandlerDataType,
  type FileHandlerEntry,
} from "./file-handler-registry";
export {
  registerFloatingPanel,
  unregisterFloatingPanel,
  unregisterFloatingPanelsByOwner,
  openFloatingPanel,
  closeFloatingPanel,
  focusFloatingPanel,
  isFloatingPanelOpen,
  getOpenFloatingPanels,
  getFloatingPanel,
  getFloatingPanelsSnapshot,
  subscribeFloatingPanels,
  type FloatingPanelsSnapshot,
} from "./floating-panel-registry";
// Public so hosts and plugins that ship their own panel-like registries can
// reuse the title-resolve-or-fallback + per-id warning-dedup behavior instead
// of re-implementing (and drifting from) it.
export { PanelTitleResolver } from "./panel-title";
export {
  el,
  setDisabled,
  SELECT_CHEVRON_CLASS,
  withSelectChevron,
  downloadBlobFallback,
  saveBinaryFileWithHost,
  createButton,
  createSelectField,
  createActionRow,
  createModalDialog,
  type PluginButtonOptions,
  type SelectFieldOption,
  type SelectFieldConfig,
  type PluginModalOptions,
} from "./panel-dom";
// Same rationale as PanelTitleResolver: the toolbar-menu label resolver is the
// one place that decides how a `string | (() => string)` label becomes display
// text, so hosts rendering plugin menus share its fallback/dedup behavior.
export {
  isToolbarLabel,
  resetToolbarLabelWarnings,
  resolveToolbarLabel,
  type GeoLibreToolbarLabel,
} from "./toolbar-menu-label";
// The translator plugins use to resolve `plugin.<id>.*` keys through the app
// API with an interpolated English fallback (see docs/plugin-api.md).
export {
  createPluginTranslator,
  interpolatePluginText,
  pluginDisplayTitle,
  type PluginTranslate,
  type PluginTranslateParams,
} from "./plugin-i18n";
export {
  LocalizedError,
  localizedMessage,
  setLocalizedErrorTranslator,
  type LocalizedErrorTranslator,
} from "./localized-error";
export {
  setPlanetaryComputerLabels,
  type PlanetaryComputerLabels,
} from "./planetary-computer-labels";
export { VIEWER_BLOCKED_PLUGIN_IDS, isViewerBlockedPlugin } from "./viewer-plugins";
export * from "./plugin-ids";
export { DGGS_PLUGIN_IDS, WEB_SERVICE_PLUGIN_IDS } from "./builtin-plugin-metadata";
