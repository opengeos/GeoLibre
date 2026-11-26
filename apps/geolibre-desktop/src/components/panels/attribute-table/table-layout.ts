// Sort keys and cell spacing shared by the attribute table and its grid.

export type SortDirection = "asc" | "desc";

export type SortKey = "__featureId" | string;

// The vertical scrollbar (w-3.5) overlays the viewport's inline-end edge, so
// the last column is widened by this much and padded past it; otherwise the
// scrollbar covers the end of right-aligned numbers.
// Both are rem so they track the scrollbar (w-3.5) and cell padding (p-2 /
// px-2) at any root font size. CELL_PADDING mirrors TableCell/TableHead in
// packages/ui/src/components/table.tsx and must change with them. (The compact
// rows below override only block padding, so the inline padding is still p-2.)
export const VERTICAL_SCROLLBAR_GUTTER = "0.875rem";

export const CELL_PADDING = "0.5rem";
