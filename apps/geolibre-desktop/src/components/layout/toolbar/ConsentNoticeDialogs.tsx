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
          {/* Split the privacy disclosure from the performance/rate-limit note so
              the data-sovereignty warning is not buried in a single paragraph. */}
          <div className="space-y-3 text-sm">
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="font-medium text-amber-700 dark:text-amber-400">
                {t("toolbar.item.networkNoticePrivacyHeading")}
              </p>
              <p className="mt-1 text-muted-foreground">
                {t("toolbar.item.networkNoticePrivacy")}
              </p>
            </div>
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="font-medium">
                {t("toolbar.item.networkNoticePerformanceHeading")}
              </p>
              <p className="mt-1 text-muted-foreground">
                {t("toolbar.item.networkNoticePerformance")}
              </p>
            </div>
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
