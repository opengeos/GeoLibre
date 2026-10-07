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
  Lock,
  LogIn,
  Share2,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import { openExternalLink } from "../../lib/open-external";
import {
  getShareAccessToken,
  resolveShareRequestToken,
  ShareOAuthError,
  shareOAuthErrorKey,
  signInToShare,
  supportsShareOAuth,
  useShareOAuthStore,
} from "../../lib/share-oauth";
import {
  fetchProjectShares,
  isShareableTitle,
  MAX_PROJECT_TITLE_LENGTH,
  resolveShareBaseUrl,
  revokeShare,
  shareHostLabel,
  ShareUploadError,
  uploadProjectToShare,
  type ActiveShare,
  type ShareExpiry,
  type ShareLinkSetting,
  type ShareRole,
  type ShareUploadErrorCode,
  type ShareUploadResult,
  type ShareVisibility,
} from "../../lib/share-geolibre";
import {
  checkShareReadiness,
  findLocalShareSources,
  isMissingForRecipients,
  type ShareReadinessInput,
  type ShareReadinessItem,
  type ShareReadinessReport,
} from "../../lib/share-readiness";
import { openSettingsSection } from "./SettingsDialog";
import { isSerializationTooLargeError } from "../../lib/project-serialization-limits";
import {
  fetchMyOrganizations,
  fetchMyGroups,
  canOwnOrganizationProjects,
  isPublicSharingBlocked,
  publicSharingRestriction,
  type ShareOrganization,
  type ShareGroup,
} from "../../lib/share-gallery";

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

/** The user guide section on what a shared project can and cannot carry. */
const SHARING_LOCAL_DATA_DOCS_URL = "https://geolibre.app/user-guide/projects/#sharing-local-data";

/**
 * What the readiness checks look at: the live layers plus the project-level
 * URLs. Read once per dialog open rather than subscribed: the dialog is modal,
 * so the snapshot it opens on is the project that will be uploaded.
 */
function readinessInput(): ShareReadinessInput {
  const state = useAppStore.getState();
  return {
    layers: state.layers,
    basemapStyleUrl: state.basemapVisible ? state.basemapStyleUrl : null,
    pluginManifestUrls: state.projectPlugins?.manifestUrls ?? [],
    // The publish path embeds these layers' features, so their local origin
    // costs the recipient nothing. Taken from the same predicate that path uses
    // so the two cannot drift.
    embeddedLayerIds: new Set(
      state.layers.filter(isEmbeddableLocalVectorLayer).map((layer) => layer.id),
    ),
  };
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

/**
 * The warning for layers that only exist on the author's machine (issue
 * #2360). Unlike the advisory list below it, this is the one case with no
 * "it may still work" reading: the share host stores the project file and
 * nothing else, so every listed layer is empty for every recipient. It is
 * shown the moment the dialog opens, before and regardless of the token setup,
 * because an author without a token may go and upload the saved file by hand.
 */
function LocalDataWarning({
  problems,
  shareHost,
}: {
  problems: readonly ShareReadinessItem[];
  shareHost: string;
}) {
  const { t } = useTranslation();
  if (problems.length === 0) return null;
  return (
    <div
      role="alert"
      data-testid="share-local-warning"
      className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
    >
      <p className="flex items-center gap-2 font-medium">
        <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        {t("share.localWarningTitle", { count: problems.length })}
      </p>
      <p className="text-xs text-muted-foreground">{t("share.localWarningBody", { shareHost })}</p>
      <ul className="max-h-40 space-y-1 overflow-y-auto">
        {problems.map((item) => (
          <li key={`${item.layerId ?? item.field}:${item.url}`} className="space-y-0.5">
            <p className="truncate font-medium" title={item.url || undefined}>
              {readinessLabel(item, t)}
            </p>
            <p className="text-xs text-muted-foreground">{t(readinessCopyKeys(item).reason)}</p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {t("share.localWarningAdvice")}{" "}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => void openExternalLink(SHARING_LOCAL_DATA_DOCS_URL)}
        >
          {t("share.localWarningLearnMore")}
        </button>
      </p>
    </div>
  );
}

// Short labels for the Active Shares metadata row, where the create tab's fully
// spelled-out options ("Unlisted (anyone with the link)") would not fit. Keyed
// through `t()` rather than rendered from the raw enum with `capitalize`, which
// would leave these strings in English in every locale. `as const` keeps the
// values literal so they still typecheck against the `en.json` key union.
const VISIBILITY_LABEL_KEYS = {
  unlisted: "share.visibilityUnlistedShort",
  public: "share.visibilityPublicShort",
  private: "share.visibilityPrivateShort",
  organization: "share.visibilityOrganizationShort",
} as const satisfies Record<ShareVisibility, string>;

const ROLE_LABEL_KEYS = {
  view: "share.roleViewShort",
  comment: "share.roleCommentShort",
  edit: "share.roleEditShort",
} as const satisfies Record<ShareRole, string>;

// Names for the link settings a server may have ignored (see
// ShareUploadResult.unconfirmedSettings), reusing the create form's labels.
const UNCONFIRMED_SETTING_LABEL_KEYS = {
  role: "share.role",
  expiry: "share.expiry",
  password: "share.passwordSetting",
} as const satisfies Record<ShareLinkSetting, string>;

export function ShareProjectDialog({
  open,
  onOpenChange,
  currentTitle,
  getProject,
}: ShareProjectDialogProps) {
  const { t, i18n } = useTranslation();
  // Resolved per render rather than at module load so a deployment env written
  // after this module was imported is still honored.
  const settingsUrl = accountSettingsUrl();
  // Named in the copy below, so a self-hosted deployment reads its own host.
  const shareHost = shareHostLabel();
  const shareToken = useDesktopSettingsStore((s) => s.desktopSettings.shareToken);
  // Web-only OAuth session. On desktop/embed both flags stay inert and the
  // pasted personal-API-token path below behaves exactly as before Stack 3.
  const oauthSupported = supportsShareOAuth();
  const oauthIssuer = useShareOAuthStore((s) => s.issuer);
  const oauthPending = useShareOAuthStore((s) => s.pending);
  const oauthSignedIn = oauthSupported && oauthIssuer !== null;
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [tab, setTab] = useState<"create" | "manage">("create");
  const [title, setTitle] = useState("");
  const [visibility, setVisibility] = useState<ShareVisibility>("public");
  const [role, setRole] = useState<ShareRole>("edit");
  const [expiresIn, setExpiresIn] = useState<ShareExpiry>("never");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "uploading">("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ShareUploadErrorCode | null>(null);
  const [result, setResult] = useState<ShareUploadResult | null>(null);
  // Which copy button last succeeded: "result" for the post-create view, else a
  // share id. One slot so only the clicked button shows the checkmark.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [redactedCount, setRedactedCount] = useState(0);
  const [readiness, setReadiness] = useState<ShareReadinessReport | null>(null);
  const [readinessState, setReadinessState] = useState<"idle" | "checking" | "failed">("idle");
  const [localProblems, setLocalProblems] = useState<ShareReadinessItem[]>([]);

  const [activeShares, setActiveShares] = useState<ActiveShare[]>([]);
  const [loadingShares, setLoadingShares] = useState(false);
  const [sharesError, setSharesError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const sharesAbortRef = useRef<AbortController | null>(null);
  const revokeAbortRef = useRef<AbortController | null>(null);
  const [organizations, setOrganizations] = useState<ShareOrganization[]>([]);
  const [groups, setGroups] = useState<ShareGroup[]>([]);
  const [orgLoading, setOrgLoading] = useState(false);
  const [groupLoading, setGroupLoading] = useState(false);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const getTokenButtonRef = useRef<HTMLButtonElement>(null);
  const copyTimeoutRef = useRef<number | null>(null);

  const hasToken = oauthSignedIn || shareToken.trim().length > 0;
  const titleValid = isShareableTitle(title);
  // The verdicts that are missing for everyone have their own block above the
  // form, so the probe report lists the rest: what the network settled, plus a
  // private-network host, which may still load for the intended recipients.
  // A row already in that block is not repeated here, whatever verdict the
  // probe summary kept for it. Keyed the way summarizeShareSources keys its
  // rows: the layer id, or field plus URL for a project-level reference.
  const rowKey = (item: ShareReadinessItem) => item.layerId ?? `${item.field}:${item.url}`;
  const missingKeys = new Set(localProblems.map(rowKey));
  const isRemoteRow = (item: ShareReadinessItem) =>
    !isMissingForRecipients(item) && !missingKeys.has(rowKey(item));
  const remoteProblems = readiness?.problems.filter(isRemoteRow) ?? [];
  const remoteItemCount = readiness?.items.filter(isRemoteRow).length ?? 0;

  // Viewers cannot own organization projects (the server answers 403), so the
  // owner picker offers only memberships that can.
  const ownerOrganizations = organizations.filter(canOwnOrganizationProjects);
  const selectedOrganization =
    ownerOrganizations.find((organization) => organization.id === selectedOrgId) ?? null;
  const publicRestriction = publicSharingRestriction(selectedOrganization);
  const publicBlocked = isPublicSharingBlocked(visibility, selectedOrganization);
  const organizationRequired = visibility === "organization" && !selectedOrganization;

  // The bearer token for the Manage tab's list and revoke calls: the web OAuth
  // session when there is one, else the pasted personal token, mirroring the
  // upload path in handleShare.
  const resolveAuthToken = useCallback(async (): Promise<string> => {
    if (oauthSupported) {
      try {
        const oauthToken = await getShareAccessToken();
        if (oauthToken) return oauthToken;
      } catch (err) {
        if (!shareToken.trim()) throw err;
      }
    }
    return shareToken;
  }, [oauthSupported, shareToken]);

  // Load (or reload) the Manage tab's list. Each load supersedes the previous
  // one: the dialog can be closed, reopened, or handed a freshly edited token
  // before an in-flight request resolves, and without cancelling, the older
  // response could land last and overwrite the newer list — or write state
  // after the dialog is gone.
  const loadActiveShares = useCallback(async () => {
    sharesAbortRef.current?.abort();
    const controller = new AbortController();
    sharesAbortRef.current = controller;
    setLoadingShares(true);
    setSharesError(null);
    try {
      const token = await resolveAuthToken();
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
      setSharesError(
        err instanceof ShareOAuthError
          ? t(shareOAuthErrorKey(err.code))
          : err instanceof Error
            ? err.message
            : t("share.sharesErrorFallback"),
      );
    } finally {
      // Only the load that is still current clears the spinner, so a
      // superseded request never hides the newer one's progress.
      if (sharesAbortRef.current === controller) {
        sharesAbortRef.current = null;
        setLoadingShares(false);
      }
    }
  }, [resolveAuthToken, t]);

  // Reset transient state whenever the dialog is (re)opened so a prior result or
  // error never lingers into a new share. Seed the title from the current
  // project name, but leave it blank when the project still has its default
  // placeholder name so the field reads as a prompt.
  useEffect(() => {
    if (open) {
      setTitle(isShareableTitle(currentTitle) ? currentTitle.trim() : "");
      setVisibility("public");
      setRole("edit");
      setExpiresIn("never");
      setPassword("");
      setStatus("idle");
      setError(null);
      setErrorCode(null);
      setResult(null);
      setCopiedKey(null);
      setRedactedCount(0);
      setOauthError(null);
      setTab("create");
      setRevokeError(null);
      setSharesError(null);
      setActiveShares([]);
      setLoadingShares(false);
      setSelectedOrgId(null);
      setSelectedGroupIds([]);
    } else {
      abortRef.current?.abort();
      abortRef.current = null;
      sharesAbortRef.current?.abort();
      sharesAbortRef.current = null;
      setLoadingShares(false);
      revokeAbortRef.current?.abort();
      revokeAbortRef.current = null;
      setRevokingId(null);
    }
  }, [open, currentTitle]);

  // Load the Manage tab's list separately from the reset above, so a sign-in or
  // token change while the dialog is open refreshes the list without wiping
  // the create form.
  useEffect(() => {
    if (open && hasToken) void loadActiveShares();
  }, [open, hasToken, loadActiveShares]);

  // Load the caller's organizations and groups for the owner and group
  // pickers, also apart from the reset so a credential change keeps the form.
  useEffect(() => {
    setOrganizations([]);
    setGroups([]);
    const load = open && hasToken;
    setOrgLoading(load);
    setGroupLoading(load);
    if (!load) return;
    const controller = new AbortController();
    // Same credential precedence as the upload: the OAuth session when signed
    // in, else the pasted personal token. A failure only hides the pickers;
    // the upload itself reports credential problems.
    const memberships = resolveShareRequestToken(shareToken).then((token) => {
      if (!token) throw new Error("no share credential");
      return { token, signal: controller.signal };
    });
    memberships
      .then(fetchMyOrganizations)
      .then((orgs) => {
        if (controller.signal.aborted) return;
        setOrganizations(orgs);
        setOrgLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setOrganizations([]);
        setOrgLoading(false);
      });
    memberships
      .then(fetchMyGroups)
      .then((grps) => {
        if (controller.signal.aborted) return;
        setGroups(grps);
        setGroupLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setGroups([]);
        setGroupLoading(false);
      });
    return () => controller.abort();
  }, [open, hasToken, shareToken]);

  // Pre-flight the project's data sources when the dialog opens, so the author
  // learns that a layer will be empty for everyone else *before* the upload
  // rather than when a recipient tells them (if they tell them).
  //
  // Layers that only exist on this machine are settled without the network,
  // so they are listed at once, token or no token. The probes need the token
  // only because there is no upload to pre-flight without one. Advisory only:
  // neither gates the Share button. An author sharing an intranet map with
  // intranet colleagues is doing the right thing.
  useEffect(() => {
    if (!open) {
      setLocalProblems([]);
      return;
    }
    const input = readinessInput();
    setLocalProblems(findLocalShareSources(input));
    if (!hasToken) return;
    const controller = new AbortController();
    setReadinessState("checking");
    setReadiness(null);
    void checkShareReadiness(input, { signal: controller.signal })
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

  // Web sign-in opens the consent popup. Failures surface as translated
  // guidance keyed by ShareOAuthError code; the session store updates on
  // success, which re-runs the readiness probe effect below (hasToken flips).
  const handleSignIn = () => {
    setOauthError(null);
    signInToShare()
      .then(() => {
        setErrorCode((code) => (code === "unauthorized" ? null : code));
      })
      .catch((err: unknown) => {
        setOauthError(
          t(err instanceof ShareOAuthError ? shareOAuthErrorKey(err.code) : "share.oauthFailed"),
        );
      });
  };

  const handleShare = async () => {
    // Guard re-entry synchronously: a second click before the disabled state
    // renders would otherwise start a concurrent, non-idempotent upload.
    if (abortRef.current || organizationRequired || publicBlocked) return;
    setError(null);
    setErrorCode(null);
    setStatus("uploading");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // Prefer OAuth; a pasted personal token remains a fallback when OAuth is
      // unavailable or its refresh endpoint is temporarily unreachable.
      let oauthToken: string | null = null;
      if (oauthSupported) {
        try {
          oauthToken = await getShareAccessToken();
        } catch (err) {
          if (
            !(err instanceof ShareOAuthError) ||
            err.code !== "refresh-unavailable" ||
            !shareToken.trim()
          ) {
            throw err;
          }
        }
      }
      if (oauthSupported && !oauthToken && !shareToken.trim()) {
        setErrorCode("unauthorized");
        setError(null);
        return;
      }
      const { content, filename, redactedCount: removed = 0 } = await getProject(title.trim());
      const uploaded = await uploadProjectToShare({
        token: oauthToken ?? shareToken,
        filename,
        content,
        visibility,
        organizationId: selectedOrganization?.id,
        groupIds: selectedGroupIds.length > 0 ? selectedGroupIds : undefined,
        role,
        expiresIn: expiresIn !== "never" ? expiresIn : undefined,
        password: password.trim() || undefined,
        signal: controller.signal,
      });
      setRedactedCount(removed);
      setResult(uploaded);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // A missing account username gets dedicated, actionable UI (a deep link to
      // the website's settings) rather than the raw server string.
      if (
        err instanceof ShareUploadError &&
        (err.code === "username-required" || err.code === "unauthorized")
      ) {
        setErrorCode(err.code);
        setError(null);
      } else {
        setError(
          err instanceof ShareOAuthError
            ? t(shareOAuthErrorKey(err.code))
            : // Embedding a large local vector layer can push the project past
              // the engine's string cap; the raw "Invalid string length" told
              // the user nothing (GeoLibre#3025).
              isSerializationTooLargeError(err)
              ? t("share.errorProjectTooLarge")
              : err instanceof Error
                ? err.message
                : t("share.errorFallback"),
        );
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
    // One revocation at a time: every revoke button is disabled while one is
    // pending, and this guards a second click before that state renders. A
    // superseding abort would drop the first result, leaving a revoked row
    // listed or an unrevoked share with no error.
    if (revokeAbortRef.current) return;
    const controller = new AbortController();
    revokeAbortRef.current = controller;
    setRevokingId(shareId);
    setRevokeError(null);
    try {
      const token = await resolveAuthToken();
      await revokeShare({ token, shareId, signal: controller.signal });
      if (revokeAbortRef.current !== controller) return;
      setActiveShares((prev) => prev.filter((s) => s.id !== shareId));
    } catch (err) {
      // Closing the dialog aborts the request, like the upload and list loads.
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (revokeAbortRef.current !== controller) return;
      setRevokeError(err instanceof Error ? err.message : t("share.revokeErrorFallback"));
    } finally {
      if (revokeAbortRef.current === controller) {
        revokeAbortRef.current = null;
        setRevokingId(null);
      }
    }
  };

  // Close this dialog and deep-link into Settings → Environment Variables with
  // the share token field focused, so the user can paste the token right away.
  const handleConfigureToken = () => {
    onOpenChange(false);
    openSettingsSection("environment", { focus: "shareToken" });
  };

  const handleCopy = (key: string, url?: string) => {
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
        setCopiedKey(key);
        copyTimeoutRef.current = window.setTimeout(() => setCopiedKey(null), 2000);
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
      <DialogContent
        className="sm:max-w-lg"
        // The local-data warning sits above both the form and the setup steps
        // and carries a link, which would otherwise take the dialog's initial
        // focus away from the title field or the first setup step.
        onOpenAutoFocus={(event) => {
          const target = titleInputRef.current ?? getTokenButtonRef.current;
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-4 w-4" />
            {t("share.title")}
          </DialogTitle>
          <DialogDescription>{t("share.description", { shareHost })}</DialogDescription>
        </DialogHeader>

        {!hasToken ? (
          <div className="space-y-4 text-sm">
            <LocalDataWarning problems={localProblems} shareHost={shareHost} />
            {oauthSupported ? (
              <div className="space-y-2 rounded-md border p-3">
                <p className="font-medium">{t("share.oauthTitle")}</p>
                <p className="text-muted-foreground">
                  {t("share.oauthSetupDescription", { shareHost })}
                </p>
                <Button
                  ref={oauthSupported ? getTokenButtonRef : undefined}
                  type="button"
                  onClick={handleSignIn}
                  disabled={oauthPending}
                >
                  {oauthPending ? (
                    <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <LogIn className="me-2 h-3.5 w-3.5" />
                  )}
                  {oauthPending ? t("share.oauthSigningIn") : t("share.oauthSignIn", { shareHost })}
                </Button>
                {oauthError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {oauthError}
                  </p>
                ) : null}
              </div>
            ) : null}
            <p className="text-muted-foreground">{t("share.setupIntro", { shareHost })}</p>
            <ol className="space-y-3">
              <li className="space-y-2 rounded-md border p-3">
                <p className="font-medium">{t("share.step1Title")}</p>
                <p className="text-muted-foreground">
                  {t("share.step1Description", { shareHost })}
                </p>
                <Button
                  ref={oauthSupported ? undefined : getTokenButtonRef}
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
            {result.unconfirmedSettings.length > 0 ? (
              <p
                role="alert"
                className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-sm"
              >
                {t("share.settingsNotApplied", {
                  shareHost,
                  settings: result.unconfirmedSettings
                    .map((setting) => t(UNCONFIRMED_SETTING_LABEL_KEYS[setting]))
                    .join(", "),
                })}
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">{t("share.liveAt")}</p>
            <div className="flex gap-2">
              <Input readOnly value={result.projectUrl} className="text-xs" />
              <Button
                type="button"
                variant="secondary"
                aria-label={t("share.copyLink")}
                onClick={() => handleCopy("result")}
              >
                {copiedKey === "result" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
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
            <LocalDataWarning problems={localProblems} shareHost={shareHost} />
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
                    ref={titleInputRef}
                    id="share-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={t("share.titlePlaceholder")}
                    maxLength={MAX_PROJECT_TITLE_LENGTH}
                    disabled={status === "uploading"}
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
                      <option value="public" disabled={publicRestriction !== null}>
                        {t("share.visibilityPublic")}
                      </option>
                      <option value="private">{t("share.visibilityPrivate")}</option>
                      <option value="organization" disabled={ownerOrganizations.length === 0}>
                        {t("share.visibilityOrganization")}
                      </option>
                    </Select>
                    {publicRestriction && (
                      <p className="text-xs text-destructive">
                        {t(
                          publicRestriction === "publisher-required"
                            ? "share.publicPublisherRequired"
                            : "share.publicDisabledByOrgPolicy",
                        )}
                      </p>
                    )}
                    {!orgLoading && organizations.length > 0 && ownerOrganizations.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        {t("share.organizationViewerOnly")}
                      </p>
                    )}
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

                {ownerOrganizations.length > 0 || orgLoading ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="share-organization">{t("share.owner")}</Label>
                    <Select
                      id="share-organization"
                      value={selectedOrgId || ""}
                      onChange={(event) => {
                        const organization =
                          ownerOrganizations.find((item) => item.id === event.target.value) ?? null;
                        setSelectedOrgId(organization?.id ?? null);
                        setVisibility(
                          organization
                            ? organization.defaultVisibility
                            : visibility === "organization"
                              ? "unlisted"
                              : visibility,
                        );
                      }}
                      disabled={status === "uploading" || orgLoading}
                    >
                      <option value="">{t("share.personalAccount")}</option>
                      {ownerOrganizations.map((org) => (
                        <option key={org.id} value={org.id}>
                          {org.name} ({org.slug})
                        </option>
                      ))}
                    </Select>
                    {orgLoading ? (
                      <p className="text-xs text-muted-foreground">
                        {t("share.loadingOrganizations")}
                      </p>
                    ) : null}
                    {organizationRequired ? (
                      <p className="text-xs text-destructive">{t("share.organizationRequired")}</p>
                    ) : null}
                  </div>
                ) : null}

                {groups.length > 0 || groupLoading ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="share-groups">{t("share.groups")}</Label>
                    <Select
                      id="share-groups"
                      multiple
                      value={selectedGroupIds}
                      onChange={(e) => {
                        const options = Array.from(e.target.selectedOptions).map((o) => o.value);
                        setSelectedGroupIds(options);
                      }}
                      disabled={status === "uploading" || groupLoading}
                      className="h-auto min-h-[80px]"
                    >
                      {groups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name} {group.sharedUpdate && `(${t("share.sharedUpdate")})`}
                        </option>
                      ))}
                    </Select>
                    {groupLoading ? (
                      <p className="text-xs text-muted-foreground">{t("share.loadingGroups")}</p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">{t("share.groupsHint")}</p>
                  </div>
                ) : null}

                {readinessState === "checking" ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t("share.readinessChecking")}
                  </p>
                ) : readinessState === "failed" ? (
                  <p className="text-xs text-muted-foreground">{t("share.readinessUnavailable")}</p>
                ) : remoteProblems.length > 0 ? (
                  <div role="status" className="space-y-2 rounded-md border p-3 text-sm">
                    <p className="flex items-center gap-2 font-medium">
                      <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                      {t("share.readinessTitle")}
                    </p>
                    <p className="text-xs text-muted-foreground">{t("share.readinessNote")}</p>
                    <ul className="max-h-48 space-y-2 overflow-y-auto">
                      {remoteProblems.map((item) => {
                        const copy = readinessCopyKeys(item);
                        return (
                          <li
                            key={`${item.layerId ?? item.field}:${item.url}`}
                            className="space-y-0.5"
                          >
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
                    {readiness?.truncated ? (
                      <p className="text-xs text-muted-foreground">
                        {t("share.readinessTruncated", { count: readiness?.probeCount ?? 0 })}
                      </p>
                    ) : null}
                  </div>
                ) : remoteItemCount > 0 ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    {t("share.readinessAllReachable", { count: remoteItemCount })}
                  </p>
                ) : null}

                {errorCode === "unauthorized" ? (
                  <div
                    role="alert"
                    className="space-y-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
                  >
                    <p>
                      {t(oauthSupported ? "share.reauthBody" : "share.errorUnauthorized", {
                        shareHost,
                      })}
                    </p>
                    {oauthSupported ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={handleSignIn}
                          disabled={oauthPending}
                        >
                          {oauthPending ? (
                            <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <LogIn className="me-2 h-3.5 w-3.5" />
                          )}
                          {t("share.reauthSignIn")}
                        </Button>
                        {oauthError ? (
                          <p role="alert" className="text-xs text-destructive">
                            {oauthError}
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleConfigureToken}
                      >
                        <KeyRound className="me-2 h-3.5 w-3.5" />
                        {t("share.configureToken")}
                      </Button>
                    )}
                  </div>
                ) : errorCode === "username-required" ? (
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
                  <p
                    role="alert"
                    className="rounded-md bg-destructive/10 p-2 text-sm text-destructive"
                  >
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
                    disabled={
                      status === "uploading" || !titleValid || organizationRequired || publicBlocked
                    }
                  >
                    {status === "uploading" ? (
                      <>
                        <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />
                        {t("share.sharing")}
                      </>
                    ) : (
                      <>
                        <Share2 className="me-2 h-3.5 w-3.5" />
                        {localProblems.length > 0 ? t("share.shareAnyway") : t("share.shareButton")}
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
                            onClick={() => handleCopy(s.id, s.projectUrl)}
                          >
                            {copiedKey === s.id ? (
                              <Check className="h-3.5 w-3.5" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            aria-label={t("share.open")}
                            title={t("share.open")}
                            onClick={() => void openExternalLink(s.projectUrl)}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            aria-label={
                              revokingId === s.id ? t("share.revoking") : t("share.revoke")
                            }
                            title={t("share.revoke")}
                            disabled={revokingId !== null}
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
