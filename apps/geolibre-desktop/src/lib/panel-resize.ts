// Window events dispatched by the docked panels (Python Console, SQL Workspace,
// Dashboard, Assistant, Attribute Table) while a drag-to-resize is in progress,
// so MapCanvas can pause expensive work until the drag ends. Shared here so the
// event names cannot drift between the dispatchers and the listener.
export const PANEL_RESIZE_START_EVENT = "geolibre:panel-resize-start";
export const PANEL_RESIZE_END_EVENT = "geolibre:panel-resize-end";
