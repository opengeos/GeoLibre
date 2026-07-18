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
import { Check, Copy, ExternalLink, KeyRound, Loader2, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import { openExternalLink } from "../../lib/open-external";
import {
  isShareableTitle,
  MAX_PROJECT_TITLE_LENGTH,
  resolveShareBaseUrl,
  ShareUploadError,
  uploadProjectToShare,
  type ShareUploadErrorCode,
  type ShareUploadResult,
  type ShareVisibility,
} from "../../lib/share-geolibre";
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
  getProject: (title: string) => Promise<{ content: string; filename: string }>;
}

// The website's account settings page, where the user both creates API tokens
// and sets the username required for sharing.
const ACCOUNT_SETTINGS_URL = `${resolveShareBaseUrl()}/settings`;

export function ShareProjectDialog({
  open,
  onOpenChange,
  currentTitle,
  getProject,
}: ShareProjectDialogProps) {
  const { t } = useTranslation();
  const shareToken = useDesktopSettingsStore((s) => s.desktopSettings.shareToken);
  const [title, setTitle] = useState("");
  const [visibility, setVisibility] = useState<ShareVisibility>("unlisted");
  const [status, setStatus] = useState<"idle" | "uploading">("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ShareUploadErrorCode | null>(null);
  const [result, setResult] = useState<ShareUploadResult | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const copyTimeoutRef = useRef<number | null>(null);

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
    } else {
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open, currentTitle]);

  // Cancel a pending "copied" reset if the dialog unmounts mid-window.
  useEffect(
    () => () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    },
    [],
  );

  const hasToken = shareToken.trim().length > 0;
  const titleValid = isShareableTitle(title);

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
      const { content, filename } = await getProject(title.trim());
      const uploaded = await uploadProjectToShare({
        token: shareToken,
        filename,
        content,
        visibility,
        signal: controller.signal,
      });
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-4 w-4" />
            {t("share.title")}
          </DialogTitle>
          <DialogDescription>{t("share.description")}</DialogDescription>
        </DialogHeader>

        {!hasToken ? (
          <div className="space-y-4 text-sm">
            <p className="text-muted-foreground">{t("share.setupIntro")}</p>
            <ol className="space-y-3">
              <li className="space-y-2 rounded-md border p-3">
                <p className="font-medium">{t("share.step1Title")}</p>
                <p className="text-muted-foreground">{t("share.step1Description")}</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void openExternalLink(ACCOUNT_SETTINGS_URL)}
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

            {errorCode === "username-required" ? (
              <div
                role="alert"
                className="space-y-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
              >
                <p>{t("share.usernameRequired")}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void openExternalLink(ACCOUNT_SETTINGS_URL)}
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
