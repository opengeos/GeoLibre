import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { GripVertical, Shapes, X } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useFloatingPanelDrag } from "../../../hooks/useFloatingPanelDrag";
import type { ObiaAddRaster } from "../../../lib/obia/obia-session";
import { ObiaAccuracyStep } from "./ObiaAccuracyStep";
import { ObiaClassifyStep } from "./ObiaClassifyStep";
import { ObiaExportStep } from "./ObiaExportStep";
import { ObiaMeasureStep } from "./ObiaMeasureStep";
import { ObiaSegmentStep } from "./ObiaSegmentStep";
import { ObiaTrainStep } from "./ObiaTrainStep";

interface ObiaWorkbenchPanelProps {
  mapControllerRef: React.RefObject<MapEngine | null>;
  /** Add GeoTIFF bytes to the map as a raster layer. */
  onAddRaster: ObiaAddRaster;
}

/**
 * Object-Based Analysis workbench (#3053). A floating panel that runs the OBIA
 * pipeline on the WASM tool runner, one step per section: segment a raster
 * layer into objects (one polygon per object, `id` = `segment_id`), measure
 * them, label training and validation samples, classify them, assess the
 * accuracy, and export the result. Each later step appears once the one before
 * it has run.
 */
export function ObiaWorkbenchPanel({
  mapControllerRef,
  onAddRaster,
}: ObiaWorkbenchPanelProps): ReactElement | null {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.obiaWorkbenchOpen);
  const setOpen = useAppStore((s) => s.setObiaWorkbenchOpen);
  const { panelRef, pos, onDragStart } = useFloatingPanelDrag();

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className={
        pos
          ? "pointer-events-auto absolute z-20 flex max-h-[calc(100%-2rem)] w-[min(26rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
          : "pointer-events-auto absolute end-3 top-16 z-20 flex max-h-[calc(100%-6rem)] w-[min(26rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
      }
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      role="region"
      aria-label={t("obia.title")}
      data-testid="obia-workbench-panel"
    >
      <div
        className="flex cursor-move touch-none select-none items-center justify-between gap-2 border-b px-3 py-2"
        onPointerDown={onDragStart}
      >
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Shapes className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">{t("obia.title")}</span>
        </div>
        <button
          type="button"
          className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
          onClick={() => setOpen(false)}
          aria-label={t("common.close")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-col gap-3 overflow-auto p-3">
        <p className="text-xs text-muted-foreground">{t("obia.description")}</p>
        <ObiaSegmentStep mapControllerRef={mapControllerRef} onAddRaster={onAddRaster} />
        <ObiaMeasureStep />
        <ObiaTrainStep />
        <ObiaClassifyStep />
        <ObiaAccuracyStep />
        <ObiaExportStep onAddRaster={onAddRaster} />
      </div>
    </div>
  );
}
