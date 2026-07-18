import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import { ArrowUpCircle, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { openExternalLink } from "../../lib/open-external";
import { APP_VERSION } from "../../lib/updates";
import type { PendingUpdate } from "../../hooks/useStartupUpdateCheck";
import { ReleaseNotes } from "./ReleaseNotes";
import { UpdateInstructions } from "./UpdateInstructions";

interface UpdateNotificationModalProps {
  /** The pending update to present, or `null` to keep the modal closed. */
  pending: PendingUpdate | null;
  /** Dismiss for this session; the prompt may reappear on the next launch. */
  onRemindLater: () => void;
  /** Suppress this exact version permanently. */
  onSkipVersion: () => void;
}

/**
 * Startup prompt shown (desktop only) when a notify-worthy newer release is
 * detected. Surfaces the current and latest versions, a scannable changelog,
 * step-by-step update guidance, and a primary download action.
 */
export function UpdateNotificationModal({
  pending,
  onRemindLater,
  onSkipVersion,
}: UpdateNotificationModalProps) {
  const { t } = useTranslation();

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open: boolean) => {
        // Closing via the overlay, Escape, or the X is "remind me later". The
        // explicit buttons clear `pending` themselves, so guard on it here to
        // avoid a redundant onRemindLater after a Skip/Remind click.
        if (!open && pending !== null) onRemindLater();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowUpCircle className="h-5 w-5 text-primary" />
            {t("updates.startup.title")}
          </DialogTitle>
          <DialogDescription>
            {pending ? t(`updates.severity.${pending.severity}`) : null}
          </DialogDescription>
        </DialogHeader>
        {pending ? (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md border bg-muted/30 px-3 py-2">
                <div className="text-xs text-muted-foreground">
                  {t("updates.startup.currentVersion")}
                </div>
                <div className="font-mono text-foreground">v{APP_VERSION}</div>
              </div>
              <div className="rounded-md border bg-muted/30 px-3 py-2">
                <div className="text-xs text-muted-foreground">
                  {t("updates.startup.latestVersion")}
                </div>
                <div className="font-mono text-foreground">{pending.release.version}</div>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("updates.changelogTitle")}
              </div>
              <ReleaseNotes notes={pending.release.notes} />
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("updates.stepsTitle")}
              </div>
              <UpdateInstructions />
            </div>
            <Button
              className="w-full justify-between"
              onClick={() => void openExternalLink(pending.release.url)}
              type="button"
              variant="default"
            >
              <span>{t("updates.startup.download")}</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
            <div className="flex items-center justify-between gap-2">
              <Button
                className="flex-1"
                onClick={onSkipVersion}
                type="button"
                variant="ghost"
                size="sm"
              >
                {t("updates.startup.skipVersion")}
              </Button>
              <Button
                className="flex-1"
                onClick={onRemindLater}
                type="button"
                variant="outline"
                size="sm"
              >
                {t("updates.startup.remindLater")}
              </Button>
            </div>
            <p className="text-center text-xs text-muted-foreground">
              {t("updates.startup.settingsHint")}
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
