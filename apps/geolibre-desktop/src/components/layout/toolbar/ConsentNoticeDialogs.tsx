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
import { RoutingConsentDialog } from "../RoutingConsentDialog";

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
      <Dialog open={consent.directionsNoticeOpen} onOpenChange={consent.setDirectionsNoticeOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.directionsNoticeTitle")}</DialogTitle>
            <DialogDescription>{t("toolbar.item.directionsNoticeDesc")}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => consent.setDirectionsNoticeOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={consent.confirmEnableDirections}>{t("toolbar.item.continue")}</Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={consent.reverseGeocodeNoticeOpen}
        onOpenChange={consent.setReverseGeocodeNoticeOpen}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.reverseGeocodeNoticeTitle")}</DialogTitle>
            <DialogDescription>{t("toolbar.item.reverseGeocodeNoticeDesc")}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => consent.setReverseGeocodeNoticeOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={consent.confirmEnableReverseGeocode}>
              {t("toolbar.item.continue")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <RoutingConsentDialog
        open={consent.routingNoticeOpen}
        onCancel={consent.dismissRoutingNotice}
        onConfirm={consent.confirmOpenNetworkTool}
      />
    </>
  );
}
