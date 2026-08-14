import { useAppStore } from "@geolibre/core";
import { isEmbeddableLocalVectorLayer } from "@geolibre/plugins";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
} from "@geolibre/ui";
import type { TFunction } from "i18next";
import {
  Check,
  CircleCheck,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  Share2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import { openExternalLink } from "../../lib/open-external";
import {
  isShareableTitle,
  MAX_PROJECT_TITLE_LENGTH,
  resolveShareBaseUrl,
  shareHostLabel,
  ShareUploadError,
  uploadProjectToShare,
  type ShareUploadErrorCode,
  type ShareUploadResult,
  type ShareVisibility,
} from "../../lib/share-geolibre";
import {
  checkShareReadiness,
  type ShareReadinessItem,
  type ShareReadinessReport,
} from "../../lib/share-readiness";
import { openSettingsSection } from "./SettingsDialog";

interface ShareProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The current project name, used to seed the title field. */
  currentTitle: string;
  /**
   * Lazily serialize the current project (under the given title) when the user
   * confirms the upload.
   */
  getProject: (
    title: string,
  ) => Promise<{ content: string; filename: string; redactedCount?: number }>;
}

/**
 * The share host's account settings page, where the user both creates API tokens
 * and sets the username required for sharing.
 *
 * Derived from the resolved host rather than hardcoded, so a self-hosted
 * deployment sends its users to its own settings page. Null when no share host is
 * configured, in which case the dialog does not render the link.
 */
function accountSettingsUrl(): string | null {
  const base = resolveShareBaseUrl();
  return base ? `${base}/settings` : null;
}

/**
 * The row's heading: a layer's own name, or a translated label for the two
 * project-level references (the basemap style and a plugin manifest), which the
 * check reports without a name of their own so it never has to be handed the
 * translation function.
 */
function readinessLabel(item: ShareReadinessItem, t: TFunction): string {
  if (item.label) return item.label;
  return item.field === "basemapStyleUrl"
    ? t("share.readinessBasemapLabel")
    : t("share.readinessPluginLabel");
}

/**
 * The plain-language reason shown for a verdict, and what the author can do
 * about it. Keyed off the reason rather than the status so an unreachable host
 * and a stripped credential read differently even though both are fatal for a
 * recipient. An `unchecked` verdict short-circuits: whatever reason it carries,
 * the honest thing to say is that the check did not settle it.
 */
function readinessCopyKeys(item: ShareReadinessItem) {
  if (item.status === "unchecked") {
    return { reason: "share.readinessReasonUnchecked", advice: null } as const;
  }
  switch (item.reason) {
    case "credential-stripped":
      return {
        reason: "share.readinessReasonCredentialStripped",
        advice: "share.readinessAdviceCredential",
      } as const;
    case "auth-required":
      return {
        reason: "share.readinessReasonAuthRequired",
        advice: "share.readinessAdviceCredential",
      } as const;
    case "cors":
      return { reason: "share.readinessReasonCors", advice: "share.readinessAdviceCors" } as const;
    case "not-found":
      return {
        reason: "share.readinessReasonNotFound",
        advice: "share.readinessAdviceNotFound",
      } as const;
    case "local-file":
      return {
        reason: "share.readinessReasonLocalFile",
        advice: "share.readinessAdviceLocal",
      } as const;
    case "private-host":
      return {
        reason: "share.readinessReasonPrivateHost",
        advice: "share.readinessAdviceLocal",
      } as const;
    case "no-source":
      return {
        reason: "share.readinessReasonNoSource",
        advice: "share.readinessAdviceLocal",
      } as const;
    default:
      return { reason: "share.readinessReasonUnchecked", advice: null } as const;
  }
}

export function ShareProjectDialog({
  open,
  onOpenChange,
  currentTitle,
  getProject,
}: ShareProjectDialogProps) {
  const { t } = useTranslation();
  // Resolved per render rather than at module load so a deployment env written
  // after this module was imported is still honored.
  const settingsUrl = accountSettingsUrl();
  // Named in the copy below, so a self-hosted deployment reads its own host.
  const shareHost = shareHostLabel();
  const shareToken = useDesktopSettingsStore((s) => s.desktopSettings.shareToken);
  const [title, setTitle] = useState("");
  const [visibility, setVisibility] = useState<ShareVisibility>("unlisted");
  const [status, setStatus] = useState<"idle" | "uploading">("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ShareUploadErrorCode | null>(null);
  const [result, setResult] = useState<ShareUploadResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [redactedCount, setRedactedCount] = useState(0);
  const [readiness, setReadiness] = useState<ShareReadinessReport | null>(null);
  const [readinessState, setReadinessState] = useState<"idle" | "checking" | "failed">("idle");
  const abortRef = useRef<AbortController | null>(null);
  const copyTimeoutRef = useRef<number | null>(null);

  const hasToken = shareToken.trim().length > 0;
  const titleValid = isShareableTitle(title);

  // Reset transient state whenever the dialog is (re)opened so a prior result or
  // error never lingers into a new share. Seed the title from the current
  // project name, but leave it blank when the project still has its default
  // placeholder name so the field reads as a prompt.
  useEffect(() => {
    if (open) {
      setTitle(isShareableTitle(currentTitle) ? currentTitle.trim() : "");
      setVisibility("unlisted");
      setStatus("idle");
      setError(null);
      setErrorCode(null);
      setResult(null);
      setCopied(false);
      setRedactedCount(0);
    } else {
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open, currentTitle]);

  // Pre-flight the project's data sources when the dialog opens, so the author
  // learns that a layer will be empty for everyone else *before* the upload
  // rather than when a recipient tells them (if they tell them).
  //
  // Advisory only: it never gates the Share button. An author sharing an
  // intranet map with intranet colleagues is doing the right thing.
  useEffect(() => {
    if (!open || !hasToken) return;
    const controller = new AbortController();
    setReadinessState("checking");
    setReadiness(null);
    // Read the live layers once rather than subscribing: the dialog is modal,
    // so the snapshot it opens on is the project that will be uploaded.
    const state = useAppStore.getState();
    void checkShareReadiness(
      {
        layers: state.layers,
        basemapStyleUrl: state.basemapVisible ? state.basemapStyleUrl : null,
        pluginManifestUrls: state.projectPlugins?.manifestUrls ?? [],
        // The publish path embeds these layers' features, so their local origin
        // costs the recipient nothing. Taken from the same predicate that path
        // uses so the two cannot drift.
        embeddedLayerIds: new Set(
          state.layers.filter(isEmbeddableLocalVectorLayer).map((layer) => layer.id),
        ),
      },
      { signal: controller.signal },
    )
      .then((report) => {
        if (controller.signal.aborted) return;
        setReadiness(report);
        setReadinessState("idle");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setReadinessState("failed");
      });
    return () => controller.abort();
  }, [open, hasToken]);

  // Cancel a pending "copied" reset if the dialog unmounts mid-window.
  useEffect(
    () => () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    },
    [],
  );

  const handleShare = async () => {
    // Guard re-entry synchronously: a second click before the disabled state
    // renders would otherwise start a concurrent, non-idempotent upload.
    if (abortRef.current) return;
    setError(null);
    setErrorCode(null);
    setStatus("uploading");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { content, filename, redactedCount: removed = 0 } = await getProject(title.trim());
      const uploaded = await uploadProjectToShare({
        token: shareToken,
        filename,
        content,
        visibility,
        signal: controller.signal,
      });
      setRedactedCount(removed);
      setResult(uploaded);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // A missing account username gets dedicated, actionable UI (a deep link to
      // the website's settings) rather than the raw server string.
      if (err instanceof ShareUploadError && err.code === "username-required") {
        setErrorCode("username-required");
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : t("share.errorFallback"));
        setErrorCode(null);
      }
    } finally {
      // Only the controller that is still current clears state, so an aborted
      // (superseded) request never flips a newer one back to idle.
      if (abortRef.current === controller) {
        abortRef.current = null;
        setStatus("idle");
      }
    }
  };

  // Close this dialog and deep-link into Settings → Environment Variables with
  // the share token field focused, so the user can paste the token right away.
  const handleConfigureToken = () => {
    onOpenChange(false);
    openSettingsSection("environment", { focus: "shareToken" });
  };

  const handleCopy = () => {
    if (!result) return;
    // Only show the "copied" checkmark if the write actually succeeds; the
    // promise rejects when clipboard permission is denied or the page is
    // unfocused, and swallowing it would flip the icon misleadingly.
    navigator.clipboard
      .writeText(result.projectUrl)
      .then(() => {
        if (copyTimeoutRef.current !== null) {
          window.clearTimeout(copyTimeoutRef.current);
        }
        setCopied(true);
        copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // Clipboard unavailable; leave the icon unchanged.
      });
  };

  // Defensive: the Share entry points (menu item and command palette) are gated on
  // the same state, so this should be unreachable. Guarding here anyway keeps a
  // future caller from rendering setup guidance that names the public hosted
  // service on a deployment that configured no share host.
  if (!settingsUrl) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Share2 className="h-4 w-4" />
              {t("share.title")}
            </DialogTitle>
            <DialogDescription>{t("gallery.errorNotConfigured")}</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-4 w-4" />
            {t("share.title")}
          </DialogTitle>
          <DialogDescription>{t("share.description", { shareHost })}</DialogDescription>
        </DialogHeader>

        {!hasToken ? (
          <div className="space-y-4 text-sm">
            <p className="text-muted-foreground">{t("share.setupIntro", { shareHost })}</p>
            <ol className="space-y-3">
              <li className="space-y-2 rounded-md border p-3">
                <p className="font-medium">{t("share.step1Title")}</p>
                <p className="text-muted-foreground">
                  {t("share.step1Description", { shareHost })}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void openExternalLink(settingsUrl)}
                >
                  <ExternalLink className="me-2 h-3.5 w-3.5" />
                  {t("share.getToken")}
                </Button>
              </li>
              <li className="space-y-2 rounded-md border p-3">
                <p className="font-medium">{t("share.step2Title")}</p>
                <p className="text-muted-foreground">{t("share.step2Description")}</p>
                <Button type="button" onClick={handleConfigureToken}>
                  <KeyRound className="me-2 h-3.5 w-3.5" />
                  {t("share.configureToken")}
                </Button>
              </li>
            </ol>
          </div>
        ) : result ? (
          <div className="space-y-3">
            {redactedCount > 0 ? (
              <p className="rounded-md bg-muted p-2 text-sm text-muted-foreground">
                {t("share.credentialsRemoved", { count: redactedCount })}
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">{t("share.liveAt")}</p>
            <div className="flex gap-2">
              <Input readOnly value={result.projectUrl} className="text-xs" />
              <Button
                type="button"
                variant="secondary"
                aria-label={t("share.copyLink")}
                onClick={handleCopy}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void openExternalLink(result.projectUrl)}
              >
                <ExternalLink className="me-2 h-3.5 w-3.5" />
                {t("share.open")}
              </Button>
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t("share.done")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="share-title">{t("share.projectTitle")}</Label>
              <Input
                id="share-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("share.titlePlaceholder")}
                maxLength={MAX_PROJECT_TITLE_LENGTH}
                disabled={status === "uploading"}
                autoFocus={!titleValid}
              />
              {!titleValid && (
                <p className="text-xs text-muted-foreground">{t("share.titleRequired")}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="share-visibility">{t("share.visibility")}</Label>
              <Select
                id="share-visibility"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as ShareVisibility)}
                disabled={status === "uploading"}
              >
                <option value="unlisted">{t("share.visibilityUnlisted")}</option>
                <option value="public">{t("share.visibilityPublic")}</option>
                <option value="private">{t("share.visibilityPrivate")}</option>
              </Select>
            </div>

            {readinessState === "checking" ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("share.readinessChecking")}
              </p>
            ) : readinessState === "failed" ? (
              <p className="text-xs text-muted-foreground">{t("share.readinessUnavailable")}</p>
            ) : readiness && readiness.problems.length > 0 ? (
              <div role="status" className="space-y-2 rounded-md border p-3 text-sm">
                <p className="flex items-center gap-2 font-medium">
                  <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  {t("share.readinessTitle")}
                </p>
                <p className="text-xs text-muted-foreground">{t("share.readinessNote")}</p>
                <ul className="max-h-48 space-y-2 overflow-y-auto">
                  {readiness.problems.map((item) => {
                    const copy = readinessCopyKeys(item);
                    return (
                      <li key={`${item.layerId ?? item.field}:${item.url}`} className="space-y-0.5">
                        <p className="truncate font-medium" title={item.url || undefined}>
                          {readinessLabel(item, t)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t(copy.reason)}
                          {copy.advice ? ` ${t(copy.advice)}` : ""}
                        </p>
                      </li>
                    );
                  })}
                </ul>
                {readiness.truncated ? (
                  <p className="text-xs text-muted-foreground">
                    {t("share.readinessTruncated", { count: readiness.probeCount })}
                  </p>
                ) : null}
              </div>
            ) : readiness && readiness.items.length > 0 ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                {t("share.readinessAllReachable", { count: readiness.items.length })}
              </p>
            ) : null}

            {errorCode === "username-required" ? (
              <div
                role="alert"
                className="space-y-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
              >
                <p>{t("share.usernameRequired", { shareHost })}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void openExternalLink(settingsUrl)}
                >
                  <ExternalLink className="me-2 h-3.5 w-3.5" />
                  {t("share.openAccountSettings")}
                </Button>
              </div>
            ) : error ? (
              <p role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              {/* Stays enabled during upload: closing the dialog aborts the
                  in-flight request via the open effect's cleanup. */}
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                onClick={() => void handleShare()}
                disabled={status === "uploading" || !titleValid}
              >
                {status === "uploading" ? (
                  <>
                    <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />
                    {t("share.sharing")}
                  </>
                ) : (
                  <>
                    <Share2 className="me-2 h-3.5 w-3.5" />
                    {t("share.shareButton")}
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
