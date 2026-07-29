import { DEFAULT_ROUTING_ENDPOINT, getRoutingConfig } from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import { useTranslation } from "react-i18next";

interface RoutingConsentDialogProps {
  open: boolean;
  /** Dismissed without consenting (Cancel, Escape, overlay click). */
  onCancel: () => void;
  /** Acknowledged: the caller records consent and proceeds. */
  onConfirm: () => void;
}

/**
 * The one-time privacy notice shown before anything sends coordinates to the
 * Valhalla routing server.
 *
 * Extracted from `ConsentNoticeDialogs` so every activation path can show the
 * same notice — the Network tools in the Processing menu, and Quick analysis's
 * drive/walk-time actions on the map context menu (#1523). A second, hand-rolled
 * copy of this notice would be the easy way for the two to drift.
 */
export function RoutingConsentDialog({ open, onCancel, onConfirm }: RoutingConsentDialogProps) {
  const { t } = useTranslation();
  const routingEndpoint = getRoutingConfig().endpoint;
  const usingDefaultRouting = routingEndpoint === DEFAULT_ROUTING_ENDPOINT;

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        // Opened programmatically (no trigger), so onOpenChange only ever fires
        // to close it (Escape / overlay).
        if (!next) onCancel();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("toolbar.item.networkNoticeTitle")}</DialogTitle>
          <DialogDescription>{t("toolbar.item.networkNoticeDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="font-medium text-amber-700 dark:text-amber-400">
              {t("toolbar.item.networkNoticePrivacyHeading")}
            </p>
            <p className="mt-1 text-muted-foreground">
              {/* Name the public server only when it is actually the default; a
                  configured private VITE_ROUTING_ENDPOINT must not be labelled
                  as the public one in this prominent warning. */}
              {usingDefaultRouting
                ? t("toolbar.item.networkNoticePrivacy")
                : t("toolbar.item.networkNoticePrivacyCustom", { endpoint: routingEndpoint })}
            </p>
          </div>
          {/* The rate-limit / "run your own server" guidance only applies to
              the shared public default; a configured endpoint is already the
              user's own server, so the block is irrelevant there. */}
          {usingDefaultRouting && (
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="font-medium">{t("toolbar.item.networkNoticePerformanceHeading")}</p>
              <p className="mt-1 text-muted-foreground">
                {t("toolbar.item.networkNoticePerformance")}
              </p>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onConfirm}>{t("toolbar.item.continue")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
