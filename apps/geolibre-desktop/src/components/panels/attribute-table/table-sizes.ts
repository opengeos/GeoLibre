// Column width and table height limits for the attribute table.

export type ColumnWidths = Record<string, number>;

export const DEFAULT_FEATURE_ID_COLUMN_WIDTH = 72;

export const DEFAULT_ATTRIBUTE_COLUMN_WIDTH = 160;

export const MIN_FEATURE_ID_COLUMN_WIDTH = 48;

export const MAX_FEATURE_ID_COLUMN_WIDTH = 180;

export const MIN_ATTRIBUTE_COLUMN_WIDTH = 72;

export const MAX_ATTRIBUTE_COLUMN_WIDTH = 520;

// Estimated row height used to size the virtualizer before real rows are
// measured. View-mode rows are ~27px (3px block padding around a 20px line);
// edit-mode rows (with an Input) are taller and are corrected by
// measureElement once rendered.
export const ESTIMATED_ROW_HEIGHT = 27;

/** Sticky header (30px) plus horizontal scrollbar (14px): the table's non-row height, in px. */
export const ATTRIBUTE_TABLE_CHROME_HEIGHT = 44;

// With the one-line toolbar and compact rows, this shows four to five rows at
// laptop widths.
export const DEFAULT_TABLE_HEIGHT = 240;

export const MIN_TABLE_HEIGHT = 96;

export const MAX_TABLE_HEIGHT = 520;
