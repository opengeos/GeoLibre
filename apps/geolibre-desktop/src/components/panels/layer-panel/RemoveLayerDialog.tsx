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
  return (
    <Dialog
      open={!!layer}
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
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
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              if (!layer) return;
              // Drop the removed layer's PostGIS session state (connection
              // string, baseline keys) so credentials don't outlive it.
              unregisterPostgisConnection(layer.id);
              removeLayer(layer.id);
              onClose();
            }}
          >
            {t("common.remove")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
