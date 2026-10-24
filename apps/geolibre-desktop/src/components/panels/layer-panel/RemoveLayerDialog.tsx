import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@geolibre/ui";
import { unregisterPostgisConnection } from "../../../lib/postgis-connections";

interface RemoveLayerDialogProps {
  /** The layer awaiting confirmation, or null when the dialog is closed. */
  layer: GeoLibreLayer | null;
  /** Close the dialog (on cancel, dismiss, or after removing). */
  onClose: () => void;
}

/** Confirmation dialog shown before a layer is removed from the project. */
export function RemoveLayerDialog({ layer, onClose }: RemoveLayerDialogProps) {
  const { t } = useTranslation();
  const removeLayer = useAppStore((s) => s.removeLayer);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const handleRemove = () => {
    if (!layer) return;
    // Drop the removed layer's PostGIS session state so credentials don't outlive it.
    unregisterPostgisConnection(layer.id);
    removeLayer(layer.id);
    onClose();
  };
  return (
    <Dialog
      open={!!layer}
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        onOpenAutoFocus={(event) => {
          if (!removeButtonRef.current) return;
          event.preventDefault();
          removeButtonRef.current.focus();
        }}
        onKeyDown={(event) => {
          // Only the focused Remove button confirms, so Delete on Cancel or
          // the close button never removes the layer.
          if (
            event.target !== removeButtonRef.current ||
            event.key !== "Delete" ||
            event.defaultPrevented ||
            event.repeat ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          ) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          handleRemove();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("layers.removeLayerConfirmTitle")}</DialogTitle>
          <DialogDescription>
            {t("layers.removeLayerConfirmBody", {
              name: layer?.name ?? t("layers.thisLayerFallback"),
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button ref={removeButtonRef} type="button" variant="destructive" onClick={handleRemove}>
            {t("common.remove")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
