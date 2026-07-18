import { type GeoLibreLayer, type SelectionMode, SELECTION_MODES } from "@geolibre/core";
import { Label, Select, cn } from "@geolibre/ui";
import type { ParseKeys } from "i18next";
import { GripHorizontal, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * Floating, non-modal window shell shared by the two selection panels
 * (#1314): a draggable card instead of a Radix modal, so the map and
 * attribute table stay interactive while selecting — pan to check a result,
 * click rows, then refine and re-run. Anchored to the map canvas like the
 * plugin FloatingPanels overlay: an `absolute inset-0` pass-through layer
 * inside the map area with the card positioned within it (top-left corner by
 * default). Drag pattern mirrors RecordVideoDialog (also adopted by the
 * Whitebox toolbox in #1226): `pos` is null until first dragged, when the
 * default corner placement (CSS class) applies; afterwards it pins to
 * explicit coords, clamped to the map area.
 */
export function SelectionFloatingPanel({
  open,
  title,
  onClose,
  defaultPositionClass,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /** Corner placement before the first drag, e.g. "start-3 top-3". */
  defaultPositionClass: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragOffset = useRef<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  if (!open) return null;

  const onDragStart = (event: React.PointerEvent) => {
    // Never begin a drag from an interactive control: the pointer capture
    // would swallow the ensuing click (e.g. the close button).
    if ((event.target as Element).closest("button, a, [role='button']")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    const bounds = panelRef.current?.parentElement?.getBoundingClientRect();
    if (!rect || !bounds) return;
    dragOffset.current = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    // Coordinates are relative to the map-area overlay, not the viewport.
    setPos({ x: rect.left - bounds.left, y: rect.top - bounds.top });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onDragMove = (event: React.PointerEvent) => {
    if (!dragOffset.current) return;
    const card = panelRef.current;
    const bounds = card?.parentElement?.getBoundingClientRect();
    if (!card || !bounds) return;
    // Keep the panel within the map area so it can't be dragged off-canvas.
    const x = Math.max(
      0,
      Math.min(event.clientX - dragOffset.current.x - bounds.left, bounds.width - card.offsetWidth),
    );
    const y = Math.max(
      0,
      Math.min(
        event.clientY - dragOffset.current.y - bounds.top,
        bounds.height - card.offsetHeight,
      ),
    );
    setPos({ x, y });
  };

  const onDragEnd = (event: React.PointerEvent) => {
    dragOffset.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      <div
        ref={panelRef}
        role="dialog"
        aria-label={title}
        style={pos ? { left: pos.x, top: pos.y } : undefined}
        className={cn(
          "pointer-events-auto absolute flex w-96 max-w-[95%] flex-col rounded-lg border bg-card text-card-foreground shadow-xl",
          pos ? "" : defaultPositionClass,
        )}
      >
        {/* Drag handle / title bar. */}
        <div
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          className="flex cursor-move touch-none select-none items-center gap-2 border-b px-3 py-2"
        >
          <GripHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-sm font-semibold">{title}</span>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[calc(100vh-12rem)] overflow-y-auto p-3">{children}</div>
      </div>
    </div>
  );
}

/**
 * Layers the interactive selection dialogs can operate on: those whose
 * features are present in the store. Matches the highlight/attribute-table
 * model, which resolves selection ids against `layer.geojson`.
 */
export function selectableVectorLayers(layers: GeoLibreLayer[]): GeoLibreLayer[] {
  return layers.filter((layer) => (layer.geojson?.features?.length ?? 0) > 0);
}

/** i18n label key per selection mode. */
export const SELECTION_MODE_LABEL_KEYS: Record<SelectionMode, ParseKeys> = {
  new: "selection.modeNew",
  add: "selection.modeAdd",
  remove: "selection.modeRemove",
  intersect: "selection.modeIntersect",
};

/**
 * The "modify current selection by" dropdown shared by both dialogs. When
 * `disableCombineModes` is set (the target layer does not hold the current
 * selection, so there is nothing to combine with), only "new" is offered —
 * add would equal new, and remove/intersect would always produce an empty
 * selection.
 */
export function SelectionModeField({
  mode,
  onChange,
  disableCombineModes = false,
}: {
  mode: SelectionMode;
  onChange: (mode: SelectionMode) => void;
  disableCombineModes?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <Label htmlFor="selection-mode">{t("selection.mode")}</Label>
      <Select
        id="selection-mode"
        value={mode}
        onChange={(event) => onChange(event.target.value as SelectionMode)}
      >
        {SELECTION_MODES.map((value) => (
          <option key={value} value={value} disabled={disableCombineModes && value !== "new"}>
            {t(SELECTION_MODE_LABEL_KEYS[value])}
          </option>
        ))}
      </Select>
    </div>
  );
}
