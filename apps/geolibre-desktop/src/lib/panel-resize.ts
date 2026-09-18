// Window events dispatched by the docked panels (Python Console, SQL Workspace,
// Dashboard, Assistant, Attribute Table) while a drag-to-resize is in progress,
// so the map can pause expensive work until the drag ends. The names live in
// `@geolibre/map` beside the listener that consumes them and are re-exported
// here, so the event names cannot drift between the dispatchers and the
// listener.
export { PANEL_RESIZE_END_EVENT, PANEL_RESIZE_START_EVENT } from "@geolibre/map";
