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
import type { useConsentGatedActions } from "../../../hooks/useConsentGatedActions";

interface ConsentNoticeDialogsProps {
  consent: ReturnType<typeof useConsentGatedActions>;
}

/**
 * The one-time consent notices shown before enabling features that send user
 * data to public third-party servers (Directions, reverse geocode, network).
 */
export function ConsentNoticeDialogs({ consent }: ConsentNoticeDialogsProps) {
  const { t } = useTranslation();
  const routingEndpoint = getRoutingConfig().endpoint;
  const usingDefaultRouting = routingEndpoint === DEFAULT_ROUTING_ENDPOINT;

  return (
    <>
      <Dialog
        open={consent.directionsNoticeOpen}
        onOpenChange={consent.setDirectionsNoticeOpen}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.directionsNoticeTitle")}</DialogTitle>
            <DialogDescription>
              {t("toolbar.item.directionsNoticeDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => consent.setDirectionsNoticeOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={consent.confirmEnableDirections}>
              {t("toolbar.item.continue")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={consent.reverseGeocodeNoticeOpen}
        onOpenChange={consent.setReverseGeocodeNoticeOpen}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t("toolbar.item.reverseGeocodeNoticeTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("toolbar.item.reverseGeocodeNoticeDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => consent.setReverseGeocodeNoticeOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={consent.confirmEnableReverseGeocode}>
              {t("toolbar.item.continue")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={consent.routingNoticeOpen}
        onOpenChange={(open: boolean) => {
          // This dialog is opened programmatically (it has no trigger), so
          // onOpenChange only ever fires to close it (Escape/overlay).
          if (!open) consent.dismissRoutingNotice();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.networkNoticeTitle")}</DialogTitle>
            <DialogDescription>
              {t("toolbar.item.networkNoticeDesc")}
            </DialogDescription>
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
                  : t("toolbar.item.networkNoticePrivacyCustom", {
                      endpoint: routingEndpoint,
                    })}
              </p>
            </div>
            {/* The rate-limit / "run your own server" guidance only applies to
                the shared public default; a configured endpoint is already the
                user's own server, so the block is irrelevant there. */}
            {usingDefaultRouting && (
              <div className="rounded-md border bg-muted/40 p-3">
                <p className="font-medium">
                  {t("toolbar.item.networkNoticePerformanceHeading")}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {t("toolbar.item.networkNoticePerformance")}
                </p>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={consent.dismissRoutingNotice}>
              {t("common.cancel")}
            </Button>
            <Button onClick={consent.confirmOpenNetworkTool}>
              {t("toolbar.item.continue")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
