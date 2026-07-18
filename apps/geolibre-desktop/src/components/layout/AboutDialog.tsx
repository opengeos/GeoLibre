import {
  Button,
  type ButtonProps,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@geolibre/ui";
import { CheckCircle2, ExternalLink, Info, Map, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openExternalLink } from "../../lib/open-external";
import {
  APP_VERSION,
  compareVersions,
  fetchLatestRelease,
  IS_STORE_BUILD,
  UPDATE_URL,
  UpdateCheckError,
} from "../../lib/updates";
import { ReleaseNotes } from "./ReleaseNotes";
import { UpdateInstructions } from "./UpdateInstructions";

const LINKS = [
  {
    labelKey: "about.homePage",
    href: "https://geolibre.app",
  },
  {
    labelKey: "about.githubRepository",
    href: "https://github.com/opengeos/GeoLibre",
  },
] as const;

type UpdateStatus = "idle" | "checking" | "current" | "available" | "error";

interface AboutDialogProps {
  checkForUpdatesRequest?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  renderTrigger?: boolean;
  buttonClassName?: string;
  buttonSize?: ButtonProps["size"];
  iconClassName?: string;
  showLabels?: boolean;
}

export function AboutDialog({
  checkForUpdatesRequest = 0,
  open,
  onOpenChange,
  renderTrigger = true,
  buttonClassName,
  buttonSize = "sm",
  iconClassName,
  showLabels = true,
}: AboutDialogProps) {
  const { t } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [latestNotes, setLatestNotes] = useState<string>("");
  const [latestUrl, setLatestUrl] = useState<string>(UPDATE_URL);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const handledCheckForUpdatesRequestRef = useRef(0);
  const wasOpenRef = useRef(false);
  const dialogOpen = open ?? internalOpen;

  useEffect(() => () => abortRef.current?.abort(), []);

  const resetUpdateState = useCallback(() => {
    setUpdateStatus("idle");
    setLatestVersion(null);
    setLatestNotes("");
    setLatestUrl(UPDATE_URL);
    setUpdateError(null);
  }, []);

  const describeUpdateError = useCallback(
    (error: unknown): string => {
      if (error instanceof UpdateCheckError) {
        switch (error.code) {
          case "rateLimit":
            return t("updates.error.rateLimit");
          case "http":
            return t("updates.error.http", { status: error.status });
          case "noTag":
            return t("updates.error.noTag");
          case "network":
          default:
            return t("updates.error.network");
        }
      }
      // Non-UpdateCheckError (an unexpected failure): reuse the network message
      // rather than duplicating the generic header string shown above it.
      return t("updates.error.network");
    },
    [t],
  );

  const handleCheckForUpdates = async () => {
    // Belt-and-braces: the Store build hides every trigger for this flow; this
    // guard ensures it never reaches out to GitHub even if one slips through
    // (policy 10.2.5).
    if (IS_STORE_BUILD) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setUpdateStatus("checking");
    setLatestVersion(null);
    setLatestNotes("");
    setLatestUrl(UPDATE_URL);
    setUpdateError(null);

    try {
      const release = await fetchLatestRelease(controller.signal);
      setLatestVersion(release.version);
      setLatestNotes(release.notes);
      setLatestUrl(release.url);
      setUpdateStatus(compareVersions(APP_VERSION, release.version) < 0 ? "available" : "current");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      console.error("Failed to check for updates", error);
      setUpdateStatus("error");
      setUpdateError(describeUpdateError(error));
    }
  };

  useEffect(() => {
    if (dialogOpen && !wasOpenRef.current) resetUpdateState();
    wasOpenRef.current = dialogOpen;
  }, [dialogOpen, resetUpdateState]);

  // Read the latest handler through a ref so the effect can depend only on
  // the command counter; the update check should run exactly once for each
  // increment. Invariant: call sites must increment checkForUpdatesRequest
  // only while also opening the dialog; an increment made while the dialog
  // stays closed would fire the check on the next open instead.
  const handleCheckForUpdatesRef = useRef(handleCheckForUpdates);
  handleCheckForUpdatesRef.current = handleCheckForUpdates;

  useEffect(() => {
    if (
      !dialogOpen ||
      checkForUpdatesRequest === 0 ||
      checkForUpdatesRequest === handledCheckForUpdatesRequestRef.current
    ) {
      return;
    }
    handledCheckForUpdatesRequestRef.current = checkForUpdatesRequest;
    void handleCheckForUpdatesRef.current();
  }, [checkForUpdatesRequest, dialogOpen]);

  const handleOpenChange = (nextOpen: boolean) => {
    setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  return (
    <Dialog open={dialogOpen} onOpenChange={handleOpenChange}>
      {renderTrigger ? (
        <DialogTrigger asChild>
          <Button
            className={buttonClassName}
            variant="ghost"
            size={buttonSize}
            aria-label={t("about.trigger")}
          >
            <Info className={iconClassName ?? "h-3.5 w-3.5 sm:me-1"} />
            {showLabels ? <span className="hidden sm:inline">{t("about.trigger")}</span> : null}
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Map className="h-5 w-5 text-primary" />
            {t("about.title")}
          </DialogTitle>
          <DialogDescription>{t("about.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
            <span className="text-muted-foreground">{t("about.version")}</span>
            <span className="font-mono text-foreground">v{APP_VERSION}</span>
          </div>
          {/* The Microsoft Store build omits the entire in-app update flow
              so the app updates only through the Store (policy 10.2.5). */}
          {!IS_STORE_BUILD && (
            <>
              <Button
                className="w-full justify-between"
                disabled={updateStatus === "checking"}
                onClick={() => void handleCheckForUpdates()}
                type="button"
                variant="outline"
              >
                <span className="inline-flex items-center gap-2">
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${updateStatus === "checking" ? "animate-spin" : ""}`}
                  />
                  {updateStatus === "checking"
                    ? t("about.checking")
                    : updateStatus === "error"
                      ? t("about.tryAgain")
                      : t("about.checkForUpdates")}
                </span>
              </Button>
              {updateStatus !== "idle" && updateStatus !== "checking" ? (
                <div className="rounded-md border bg-muted/30 px-3 py-2">
                  {updateStatus === "current" ? (
                    <div className="flex items-center gap-2 text-foreground">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      <span>
                        {latestVersion
                          ? t("about.upToDate", { version: latestVersion })
                          : t("about.upToDateNoVersion")}
                      </span>
                    </div>
                  ) : null}
                  {updateStatus === "available" ? (
                    <div className="space-y-3">
                      <div className="font-medium text-foreground">
                        {t("updates.available.title", {
                          version: latestVersion ?? t("updates.available.fallback"),
                        })}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t("updates.available.summary", {
                          current: `v${APP_VERSION}`,
                        })}
                      </div>
                      <div className="space-y-1.5">
                        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {t("updates.changelogTitle")}
                        </div>
                        <ReleaseNotes notes={latestNotes} />
                      </div>
                      <div className="space-y-1.5">
                        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {t("updates.stepsTitle")}
                        </div>
                        <UpdateInstructions />
                      </div>
                      <Button
                        className="w-full justify-between"
                        onClick={() => void openExternalLink(latestUrl)}
                        type="button"
                        variant="default"
                      >
                        <span>{t("updates.download")}</span>
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ) : null}
                  {updateStatus === "error" ? (
                    <div className="space-y-2">
                      <div className="text-foreground">{t("updates.error.message")}</div>
                      {updateError ? (
                        <div className="text-xs text-muted-foreground">{updateError}</div>
                      ) : null}
                      {/* Group the hint with its button and divide it from the error
                          message above so the two muted lines do not read as one. */}
                      <div className="space-y-1.5 border-t pt-2">
                        <div className="text-xs text-muted-foreground">
                          {t("updates.error.viewDownloadsHint")}
                        </div>
                        <Button
                          className="w-full justify-between"
                          onClick={() => void openExternalLink(UPDATE_URL)}
                          type="button"
                          variant="outline"
                        >
                          <span>{t("updates.error.viewDownloads")}</span>
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
          <div className="space-y-2 border-t pt-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("about.generalSectionTitle")}
            </div>
            {LINKS.map((link) => (
              <a
                key={link.href}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                href={link.href}
                onClick={(event) => {
                  event.preventDefault();
                  void openExternalLink(link.href);
                }}
                rel="noreferrer"
                target="_blank"
              >
                <span>{t(link.labelKey)}</span>
                <span className="inline-flex items-center gap-2 text-muted-foreground">
                  {link.href.replace(/^https?:\/\//, "")}
                  <ExternalLink className="h-3.5 w-3.5" />
                </span>
              </a>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
