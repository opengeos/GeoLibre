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
import { Check, Copy, ExternalLink, KeyRound, Loader2, Lock, Share2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import { openExternalLink } from "../../lib/open-external";
import {
  fetchProjectShares,
  isShareableTitle,
  MAX_PROJECT_TITLE_LENGTH,
  resolveShareBaseUrl,
  revokeShare,
  ShareUploadError,
  uploadProjectToShare,
  type ActiveShare,
  type ShareExpiry,
  type ShareRole,
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

// Short labels for the Active Shares metadata row, where the create tab's fully
// spelled-out options ("Unlisted (anyone with the link)") would not fit. Keyed
// through `t()` rather than rendered from the raw enum with `capitalize`, which
// would leave these strings in English in every locale. `as const` keeps the
// values literal so they still typecheck against the `en.json` key union.
const VISIBILITY_LABEL_KEYS = {
  unlisted: "share.visibilityUnlistedShort",
  public: "share.visibilityPublicShort",
  private: "share.visibilityPrivateShort",
} as const satisfies Record<ShareVisibility, string>;

const ROLE_LABEL_KEYS = {
  view: "share.roleViewShort",
  comment: "share.roleCommentShort",
  edit: "share.roleEditShort",
} as const satisfies Record<ShareRole, string>;

export function ShareProjectDialog({
  open,
  onOpenChange,
  currentTitle,
  getProject,
}: ShareProjectDialogProps) {
  const { t, i18n } = useTranslation();
  const shareToken = useDesktopSettingsStore((s) => s.desktopSettings.shareToken);
  const [tab, setTab] = useState<"create" | "manage">("create");
  const [title, setTitle] = useState("");
  const [visibility, setVisibility] = useState<ShareVisibility>("unlisted");
  const [role, setRole] = useState<ShareRole>("edit");
  const [expiresIn, setExpiresIn] = useState<ShareExpiry>("never");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "uploading">("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ShareUploadErrorCode | null>(null);
  const [result, setResult] = useState<ShareUploadResult | null>(null);
  const [copied, setCopied] = useState(false);

  const [activeShares, setActiveShares] = useState<ActiveShare[]>([]);
  const [loadingShares, setLoadingShares] = useState(false);
  const [sharesError, setSharesError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const sharesAbortRef = useRef<AbortController | null>(null);
  const copyTimeoutRef = useRef<number | null>(null);

  // Load (or reload) the Manage tab's list. Each load supersedes the previous
  // one: the dialog can be closed, reopened, or handed a freshly edited token
  // before an in-flight request resolves, and without cancelling, the older
  // response could land last and overwrite the newer list — or write state
  // after the dialog is gone.
  const loadActiveShares = useCallback(
    async (token: string) => {
      sharesAbortRef.current?.abort();
      const controller = new AbortController();
      sharesAbortRef.current = controller;
      setLoadingShares(true);
      setSharesError(null);
      try {
        const shares = await fetchProjectShares({ token, signal: controller.signal });
        if (sharesAbortRef.current !== controller) return;
        setActiveShares(shares);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (sharesAbortRef.current !== controller) return;
        // An empty list and a failed fetch are not the same thing: swallowing the
        // error would render an expired token or a dropped connection as the
        // reassuring "no active share links" empty state.
        setActiveShares([]);
        setSharesError(err instanceof Error ? err.message : t("share.sharesErrorFallback"));
      } finally {
        // Only the load that is still current clears the spinner, so a
        // superseded request never hides the newer one's progress.
        if (sharesAbortRef.current === controller) {
          sharesAbortRef.current = null;
          setLoadingShares(false);
        }
      }
    },
    [t],
  );

  // Reset transient state whenever the dialog is (re)opened so a prior result or
  // error never lingers into a new share. Seed the title from the current
  // project name, but leave it blank when the project still has its default
  // placeholder name so the field reads as a prompt.
  useEffect(() => {
    if (open) {
      setTitle(isShareableTitle(currentTitle) ? currentTitle.trim() : "");
      setVisibility("unlisted");
      setRole("edit");
      setExpiresIn("never");
      setPassword("");
      setStatus("idle");
      setError(null);
      setErrorCode(null);
      setResult(null);
      setCopied(false);
      setTab("create");
      setRevokeError(null);
      setSharesError(null);
      setActiveShares([]);
      setLoadingShares(false);

      if (shareToken.trim()) {
        void loadActiveShares(shareToken);
      }
    } else {
      abortRef.current?.abort();
      abortRef.current = null;
      sharesAbortRef.current?.abort();
      sharesAbortRef.current = null;
      setLoadingShares(false);
    }
  }, [open, currentTitle, shareToken, loadActiveShares]);

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
        role,
        expiresIn: expiresIn !== "never" ? expiresIn : undefined,
        password: password.trim() || undefined,
        signal: controller.signal,
      });
      setResult(uploaded);
      void loadActiveShares(shareToken);
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

  const handleRevoke = async (shareId: string) => {
    // Revoking is immediate and irreversible — the link stops working for
    // everyone it was sent to — so a stray click on the icon-only button must
    // not be enough to do it. `window.confirm` is blocking and matches how the
    // rest of the app gates destructive actions.
    if (!window.confirm(t("share.revokeConfirm"))) return;
    setRevokingId(shareId);
    setRevokeError(null);
    try {
      await revokeShare({ token: shareToken, shareId });
      setActiveShares((prev) => prev.filter((s) => s.id !== shareId));
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : t("share.revokeErrorFallback"));
    } finally {
      setRevokingId(null);
    }
  };

  // Close this dialog and deep-link into Settings → Environment Variables with
  // the share token field focused, so the user can paste the token right away.
  const handleConfigureToken = () => {
    onOpenChange(false);
    openSettingsSection("environment", { focus: "shareToken" });
  };

  const handleCopy = (url?: string) => {
    const targetUrl = url || result?.projectUrl;
    if (!targetUrl) return;
    // Only show the "copied" checkmark if the write actually succeeds; the
    // promise rejects when clipboard permission is denied or the page is
    // unfocused, and swallowing it would flip the icon misleadingly.
    navigator.clipboard
      .writeText(targetUrl)
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
                onClick={() => handleCopy()}
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
            <div className="flex border-b border-border">
              <button
                type="button"
                className={`px-3 py-1.5 text-sm font-medium border-b-2 ${
                  tab === "create"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setTab("create")}
              >
                {t("share.createShare", "New Share")}
              </button>
              <button
                type="button"
                className={`px-3 py-1.5 text-sm font-medium border-b-2 ${
                  tab === "manage"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setTab("manage")}
              >
                {t("share.activeShares", "Active Shares")}
                {activeShares.length > 0 && (
                  <span className="ms-1.5 rounded-full bg-secondary px-1.5 py-0.5 text-xs">
                    {activeShares.length}
                  </span>
                )}
              </button>
            </div>

            {tab === "create" ? (
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

                <div className="grid grid-cols-2 gap-3">
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

                  <div className="space-y-1.5">
                    <Label htmlFor="share-role">{t("share.role", "Access Role")}</Label>
                    <Select
                      id="share-role"
                      value={role}
                      onChange={(e) => setRole(e.target.value as ShareRole)}
                      disabled={status === "uploading"}
                    >
                      <option value="edit">{t("share.roleEdit", "Edit (full app)")}</option>
                      <option value="comment">
                        {t("share.roleComment", "Comment (view & comments)")}
                      </option>
                      <option value="view">{t("share.roleView", "View (read-only)")}</option>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="share-expiry">{t("share.expiry", "Link Expiry")}</Label>
                    <Select
                      id="share-expiry"
                      value={expiresIn}
                      onChange={(e) => setExpiresIn(e.target.value as ShareExpiry)}
                      disabled={status === "uploading"}
                    >
                      <option value="never">{t("share.expiryNever", "Never")}</option>
                      <option value="24h">{t("share.expiry24h", "24 hours")}</option>
                      <option value="7d">{t("share.expiry7d", "7 days")}</option>
                      <option value="30d">{t("share.expiry30d", "30 days")}</option>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="share-password">{t("share.password", "Password")}</Label>
                    <Input
                      id="share-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={t("share.passwordPlaceholder", "Optional password")}
                      disabled={status === "uploading"}
                    />
                  </div>
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
                  <p
                    role="alert"
                    className="rounded-md bg-destructive/10 p-2 text-sm text-destructive"
                  >
                    {error}
                  </p>
                ) : null}

                <div className="flex justify-end gap-2">
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
            ) : (
              <div className="space-y-3">
                {revokeError && (
                  <p
                    role="alert"
                    className="rounded-md bg-destructive/10 p-2 text-sm text-destructive"
                  >
                    {revokeError}
                  </p>
                )}
                {sharesError && (
                  <p
                    role="alert"
                    className="rounded-md bg-destructive/10 p-2 text-sm text-destructive"
                  >
                    {sharesError}
                  </p>
                )}
                {loadingShares ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : activeShares.length === 0 ? (
                  // Suppress the reassuring empty state when the list failed to
                  // load; the error above already explains why it is empty.
                  sharesError ? null : (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                      {t("share.noActiveShares")}
                    </p>
                  )
                ) : (
                  <div className="max-h-60 space-y-2 overflow-y-auto pe-1">
                    {activeShares.map((s) => (
                      <div
                        key={s.id}
                        className="flex items-center justify-between gap-2 rounded-md border p-2.5 text-xs"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <p className="truncate font-medium">{s.title || s.projectSlug}</p>
                          <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                            <span>{t(VISIBILITY_LABEL_KEYS[s.visibility])}</span>
                            <span>•</span>
                            <span>{t(ROLE_LABEL_KEYS[s.role])}</span>
                            {s.hasPassword && (
                              <>
                                <span>•</span>
                                <span className="flex items-center gap-1">
                                  <Lock className="h-3 w-3" />
                                  {t("share.passwordProtected")}
                                </span>
                              </>
                            )}
                            {s.expiresAt && (
                              <>
                                <span>•</span>
                                <span>
                                  {t("share.expires")}{" "}
                                  {new Date(s.expiresAt).toLocaleDateString(i18n.language)}
                                </span>
                              </>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            aria-label={t("share.copyLink")}
                            title={t("share.copyLink")}
                            onClick={() => handleCopy(s.projectUrl)}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            aria-label={
                              revokingId === s.id ? t("share.revoking") : t("share.revoke")
                            }
                            title={t("share.revoke")}
                            disabled={revokingId === s.id}
                            onClick={() => void handleRevoke(s.id)}
                          >
                            {revokingId === s.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex justify-end pt-2">
                  <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
