// Drag type and window/pane size limits for the Model Builder panel.

/** MIME type carrying a palette tool key through an HTML5 drag. */
export const TOOL_DRAG_TYPE = "application/x-geolibre-model-tool";

/** Bounds on the draggable palette and inspector columns, in pixels. */
export const MIN_SIDE_WIDTH = 140;

export const MAX_SIDE_WIDTH = 480;

export const DEFAULT_PALETTE_WIDTH = 208;

export const DEFAULT_INSPECTOR_WIDTH = 224;

/** Bounds on the draggable log pane, in pixels. */
export const MIN_LOG_HEIGHT = 56;

export const MAX_LOG_HEIGHT = 420;

export const DEFAULT_LOG_HEIGHT = 96;

/** Share of the panel height the log pane may take, so the canvas survives. */
export const MAX_LOG_FRACTION = 0.6;

/**
 * Share of the panel a single side column may take. Both columns are
 * `shrink-0`, so without this two columns dragged wide (or a panel later
 * resized narrow) would squeeze the canvas between them to nothing with no way
 * left to grab a node and drag the column back.
 */
export const MAX_SIDE_FRACTION = 0.4;

/**
 * Preferred floors. They are *preferences*, not hard limits: a container
 * narrower than this gets a panel narrower than this, because a panel that
 * refuses to shrink below 820px on a 420px screen simply hangs off the edge
 * with its Run and Close buttons unreachable.
 */
export const MIN_WIDTH = 820;

export const MIN_HEIGHT = 420;

/** Absolute floors, below which the panel stops being usable at all. */
export const FLOOR_WIDTH = 260;

export const FLOOR_HEIGHT = 220;

/** Width a side pane takes when it overlays the canvas in compact mode. */
export const COMPACT_PANE_WIDTH = 240;

/**
 * Below this the palette, canvas and inspector cannot share a row: three
 * columns leave the canvas a sliver. The side panes become overlays opened one
 * at a time from the title bar instead, so the canvas keeps the full width.
 */
export const COMPACT_WIDTH = 720;

export const EDGE_MARGIN = 12;
