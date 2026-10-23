import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from "@geolibre/ui";
import {
  AlertCircle,
  ArrowRightLeft,
  Eye,
  EyeOff,
  ExternalLink,
  Globe2,
  ImageOff,
  Loader2,
  Lock,
  LogIn,
  Search,
  Shield,
  ShieldCheck,
  ShieldOff,
  Star,
  User,
  UserPlus,
  Users,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import { galleryErrorMessage } from "../../lib/gallery-errors";
import { observeGalleryEnd } from "../../lib/gallery-auto-load";
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
  acceptProjectTransfer,
  cancelProjectTransfer,
  declineProjectTransfer,
  fetchIncomingTransfers,
  fetchMyProjects,
  fetchMyGroups,
  fetchMyOrganizations,
  fetchOutgoingTransfers,
  fetchProjectsSharedWithMe,
  fetchSharedProjects,
  GalleryError,
  type GalleryErrorCode,
  loadSharedProjectThumbnail,
  projectOpenToken,
  requestProjectTransfer,
  setProjectDeleteProtection,
  type ProjectTransfer,
  type ProjectTransferTarget,
  type SharedProject,
  type ShareOrganization,
  type ShareGroup,
} from "../../lib/share-gallery";
import { resolveShareBaseUrl, shareHostLabel } from "../../lib/share-geolibre";
import { TransferProjectDialog } from "./TransferProjectDialog";

type GalleryScope = "featured" | "all" | "mine" | "organizations" | "groups";

interface ProjectGalleryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Load a project from its raw `.geolibre.json` URL into the app. `authToken`
   * is passed for the user's own (unlisted/private) projects so the share host
   * authorizes the fetch. Resolves on success and rejects with a descriptive
   * error the dialog surfaces inline.
   */
  onOpenProject: (
    rawJsonUrl: string,
    authToken?: string,
    options?: {
      asCopy?: boolean;
      oauthSessionRevision?: number;
      remoteProject?: {
        id: string;
        versionCount: number;
        canEdit: boolean;
        token: string;
        baseUrl: string;
        oauthSessionRevision?: number;
      };
    },
  ) => Promise<void>;
}

// Page size for each listing request. The endpoint paginates by limit + offset.
const PAGE_SIZE = 24;

/** Lowercased haystack for the client-side title/author/tag filter. */
function searchHaystack(project: SharedProject): string {
  return [project.title, project.username, ...project.tags].join(" ").toLowerCase();
}

/**
 * Browse public projects shared on the configured share host and open one in
 * GeoLibre.
 *
 * The listing endpoint only paginates (no server-side search), so this loads
 * pages automatically as the user nears the end of the list and filters the
 * already-loaded set in the browser.
 */
export function ProjectGalleryDialog({
  open,
  onOpenChange,
  onOpenProject,
}: ProjectGalleryDialogProps) {
  const { t } = useTranslation();
  const trimmedToken = (useDesktopSettingsStore((s) => s.desktopSettings.shareToken) ?? "").trim();
  // A project OAuth session can change on both web and desktop. A pasted PAT
  // remains usable independently, but private data from the old OAuth account
  // must be dropped before the next paint.
  const oauthSupported = supportsShareOAuth();
  const oauthIssuer = useShareOAuthStore((s) => s.issuer);
  const oauthSessionRevision = useShareOAuthStore((s) => s.sessionRevision);
  const oauthPending = useShareOAuthStore((s) => s.pending);
  const oauthSignedIn = oauthSupported && oauthIssuer !== null;
  const hasToken = oauthSignedIn || trimmedToken.length > 0;
  const [scope, setScope] = useState<GalleryScope>("featured");
  const [projects, setProjects] = useState<SharedProject[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "loadingMore">("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<GalleryErrorCode | null>(null);
  const [hasMore, setHasMore] = useState(false);
  // Next-page offset tracked from the server's raw record count, not the
  // filtered `projects.length` (normalizeProject may drop records, which would
  // otherwise undershoot the offset and re-deliver already-seen entries).
  const [rawOffset, setRawOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [openingState, setOpeningState] = useState<{
    id: string;
    action: "open" | "copy";
  } | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const membershipAbortRef = useRef<AbortController | null>(null);
  const defaultScopePendingRef = useRef(true);
  const reloadGenerationRef = useRef(0);
  const previousSessionRevisionRef = useRef(oauthSessionRevision);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  // The resolved Bearer credential (OAuth access token when signed in, else
  // the pasted personal token) used for thumbnail loads, which render
  // synchronously per card. Requests that start from a user action resolve a
  // fresh token instead, so a short-lived OAuth access token never goes stale.
  const [requestToken, setRequestToken] = useState("");

  const [organizations, setOrganizations] = useState<ShareOrganization[]>([]);
  const [groups, setGroups] = useState<ShareGroup[]>([]);

  // Ownership transfer and delete protection (GeoLibre#1670). Only the "mine"
  // scope shows these; the incoming list is the accept/decline inbox, the
  // outgoing list backs the "transfer pending" state on a card.
  const [incomingTransfers, setIncomingTransfers] = useState<ProjectTransfer[]>([]);
  const [outgoingTransfers, setOutgoingTransfers] = useState<ProjectTransfer[]>([]);
  const [manageBusyId, setManageBusyId] = useState<string | null>(null);
  const [manageError, setManageError] = useState<string | null>(null);
  const [transferProject, setTransferProject] = useState<SharedProject | null>(null);
  // Per-transfer slug override, seeded when an accept collides with an
  // existing project at the destination slug.
  const [acceptSlugs, setAcceptSlugs] = useState<Record<string, string>>({});

  // Authenticated scopes disappear with the token; fall back instead of making
  // an empty-token request if Settings changes while the dialog is open.
  const authenticatedScope = scope === "mine" || scope === "organizations" || scope === "groups";
  const effectiveScope: GalleryScope = authenticatedScope && !hasToken ? "featured" : scope;

  // Explicit dialog size once the user drags the corner grip (null = the
  // default responsive size). `dialogRef` reads the live element size at the
  // start of a drag; `resizeCleanupRef` tears down listeners on unmount.
  const dialogRef = useRef<HTMLDivElement>(null);
  const [dialogSize, setDialogSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  useEffect(() => {
    if (open) {
      defaultScopePendingRef.current = true;
      setScope("featured");
    }
  }, [open]);

  // Resize the whole dialog from its bottom-right grip. The dialog is centred
  // via a -50% transform, so each edge moves by half the size change; growing
  // by 2x the pointer delta keeps the grip under the cursor (mirrors the Print
  // Layout dialog's resize idiom).
  const startDialogResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const el = dialogRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startW = rect.width;
    const startH = rect.height;
    let next = { width: startW, height: startH };
    let frame: number | null = null;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";

    const onMove = (e: PointerEvent) => {
      next = {
        width: Math.max(480, Math.min(window.innerWidth - 16, startW + (e.clientX - startX) * 2)),
        height: Math.max(360, Math.min(window.innerHeight - 16, startH + (e.clientY - startY) * 2)),
      };
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        setDialogSize(next);
      });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (frame !== null) window.cancelAnimationFrame(frame);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      resizeCleanupRef.current = null;
    };
    const onUp = () => {
      cleanup();
      setDialogSize(next);
    };
    resizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  // Fetch a page. `offset === 0` is the initial load (replaces the list);
  // anything else appends. Each call supersedes a prior in-flight fetch.
  const loadPage = useCallback(
    async (offset: number) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setStatus(offset === 0 ? "loading" : "loadingMore");
      setError(null);
      setErrorCode(null);
      try {
        if (effectiveScope === "mine") {
          // "My projects" returns the owner's full set, including unlisted and
          // private projects. Prefer OAuth when available, with a personal-token
          // fallback for desktop and transient OAuth refresh failures.
          let token = trimmedToken;
          if (oauthSupported) {
            try {
              token = (await getShareAccessToken()) ?? trimmedToken;
            } catch (err) {
              if (
                !(err instanceof ShareOAuthError) ||
                err.code !== "refresh-unavailable" ||
                !trimmedToken
              ) {
                throw err;
              }
            }
          }
          const mine = await fetchMyProjects({
            token,
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setProjects(mine);
          setHasMore(false);
          // Transfers are a best-effort add-on: a share host without the
          // endpoints (an older deployment) must not break "My projects".
          // Preserve a previously loaded inbox through transient fetch failures;
          // open and session changes clear it when the account can change.
          const [incoming, outgoing] = await Promise.allSettled([
            fetchIncomingTransfers({ token, signal: controller.signal }),
            fetchOutgoingTransfers({ token, signal: controller.signal }),
          ]);
          if (controller.signal.aborted) return;
          if (incoming.status === "fulfilled") setIncomingTransfers(incoming.value);
          if (outgoing.status === "fulfilled") setOutgoingTransfers(outgoing.value);
        } else if (effectiveScope === "organizations" || effectiveScope === "groups") {
          const token = await resolveShareRequestToken(trimmedToken);
          const result = await fetchProjectsSharedWithMe({
            token,
            source: effectiveScope,
            limit: PAGE_SIZE,
            offset,
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setProjects((prev) => (offset === 0 ? result.projects : [...prev, ...result.projects]));
          setHasMore(result.hasMore);
          setRawOffset(offset + result.rawCount);
        } else {
          // "featured" and "all" both page through the public listing; featured
          // adds the ?featured=true filter.
          const result = await fetchSharedProjects({
            limit: PAGE_SIZE,
            offset,
            featured: effectiveScope === "featured",
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setProjects((prev) => (offset === 0 ? result.projects : [...prev, ...result.projects]));
          setHasMore(result.hasMore);
          // Advance by the server's raw count so dropped records can't skew the
          // next offset.
          setRawOffset(offset + result.rawCount);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Failed to load project gallery", err);
        setErrorCode(err instanceof GalleryError ? err.code : null);
        setError(galleryErrorMessage(err, t, oauthSupported));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (!controller.signal.aborted) setStatus("idle");
      }
    },
    [t, effectiveScope, trimmedToken, oauthSupported],
  );
  useLayoutEffect(() => {
    if (previousSessionRevisionRef.current === oauthSessionRevision) return;
    previousSessionRevisionRef.current = oauthSessionRevision;
    abortRef.current?.abort();
    membershipAbortRef.current?.abort();
    setProjects([]);
    setRequestToken("");
    setOrganizations([]);
    setGroups([]);
    setOpeningState(null);
    setIncomingTransfers([]);
    setOutgoingTransfers([]);
    setAcceptSlugs({});
    setManageError(null);
    setTransferProject(null);
  }, [oauthSessionRevision]);

  const handleSignIn = () => {
    signInToShare()
      .then(() => setErrorCode(null))
      .catch((err: unknown) => {
        setError(
          t(err instanceof ShareOAuthError ? shareOAuthErrorKey(err.code) : "share.oauthFailed"),
        );
      });
  };

  // Reload from the first page when the dialog opens or the scope changes (the
  // `loadPage` identity changes with scope); reset transient state and abort any
  // in-flight fetch when it closes.
  useEffect(() => {
    reloadGenerationRef.current += 1;
    if (open) {
      setProjects([]);
      setQuery("");
      setOpeningState(null);
      setOpenError(null);
      setErrorCode(null);
      setHasMore(false);
      setRawOffset(0);
      setIncomingTransfers([]);
      setOutgoingTransfers([]);
      setAcceptSlugs({});
      setManageError(null);
      setTransferProject(null);
      void loadPage(0);
    } else {
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open, loadPage, oauthSessionRevision]);

  useEffect(() => {
    if (!open || !hasToken) {
      setOrganizations([]);
      setGroups([]);
      setRequestToken("");
      return;
    }
    const controller = new AbortController();
    membershipAbortRef.current = controller;
    // Same credential precedence as the listings: OAuth session first, the
    // pasted personal token as the fallback.
    const fetchOptions = resolveShareRequestToken(trimmedToken).then((token) => {
      if (!controller.signal.aborted) setRequestToken(token);
      if (!token) throw new Error("no share credential");
      return { token, signal: controller.signal };
    });
    void fetchOptions
      .then(fetchMyOrganizations)
      .then((orgs) => {
        if (controller.signal.aborted) return;
        setOrganizations(orgs);
        if (defaultScopePendingRef.current) {
          setScope(orgs.length > 0 ? "organizations" : "featured");
          defaultScopePendingRef.current = false;
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setOrganizations([]);
      });
    void fetchOptions
      .then(fetchMyGroups)
      .then((grps) => {
        if (controller.signal.aborted) return;
        setGroups(grps);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setGroups([]);
      });
    return () => {
      controller.abort();
      if (membershipAbortRef.current === controller) membershipAbortRef.current = null;
    };
  }, [open, hasToken, trimmedToken, oauthIssuer, oauthSessionRevision]);

  const selectScope = (nextScope: GalleryScope) => {
    defaultScopePendingRef.current = false;
    setScope(nextScope);
  };

  const handleOpen = async (project: SharedProject, options: { asCopy?: boolean } = {}) => {
    const action = options.asCopy ? "copy" : "open";
    setOpeningState({ id: project.id, action });
    setOpenError(null);
    try {
      const asCopy = options.asCopy === true;
      const isProtected = project.visibility !== "public" && project.visibility !== "unlisted";
      // Only protected (private/organization) projects need credentials to
      // open; projectOpenToken keeps public and unlisted opens anonymous to
      // avoid a CORS preflight. The token is resolved per open so an OAuth
      // access token is fresh, and skipped for an anonymous read-only open.
      const token =
        isProtected || (!asCopy && project.canEdit)
          ? await resolveShareRequestToken(trimmedToken)
          : "";
      await onOpenProject(project.rawJsonUrl, projectOpenToken(project, token), {
        asCopy,
        oauthSessionRevision:
          oauthIssuer && token !== trimmedToken ? oauthSessionRevision : undefined,
        remoteProject: asCopy
          ? undefined
          : {
              id: project.id,
              versionCount: project.versionCount,
              canEdit: project.canEdit,
              // The personal-token fallback; the save path re-resolves the
              // OAuth access token at save time.
              token: trimmedToken,
              baseUrl: resolveShareBaseUrl() ?? "",
              oauthSessionRevision:
                oauthIssuer && token !== trimmedToken ? oauthSessionRevision : undefined,
            },
      });
      onOpenChange(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setOpenError(
        err instanceof ShareOAuthError
          ? t(shareOAuthErrorKey(err.code))
          : err instanceof Error
            ? err.message
            : t("gallery.openError"),
      );
    } finally {
      setOpeningState(null);
    }
  };

  // Toggle "prevent deletion" for one of the caller's projects and swap the
  // returned record in, so the badge updates without a full reload.
  const handleToggleDeleteProtection = async (project: SharedProject) => {
    setManageBusyId(project.id);
    setManageError(null);
    try {
      const token = await resolveShareRequestToken(trimmedToken);
      const updated = await setProjectDeleteProtection({
        token,
        projectId: project.id,
        deleteProtected: project.deleteProtected !== true,
      });
      setProjects((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setManageError(galleryErrorMessage(err, t, oauthSupported));
    } finally {
      setManageBusyId(null);
    }
  };

  const handleCancelTransfer = async (transfer: ProjectTransfer) => {
    setManageBusyId(transfer.projectId);
    setManageError(null);
    try {
      const token = await resolveShareRequestToken(trimmedToken);
      await cancelProjectTransfer({ token, transferId: transfer.id });
      setOutgoingTransfers((prev) => prev.filter((item) => item.id !== transfer.id));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setManageError(galleryErrorMessage(err, t, oauthSupported));
    } finally {
      setManageBusyId(null);
    }
  };

  const handleAcceptTransfer = async (transfer: ProjectTransfer) => {
    setManageBusyId(transfer.projectId);
    setManageError(null);
    try {
      const token = await resolveShareRequestToken(trimmedToken);
      await acceptProjectTransfer({
        token,
        transferId: transfer.id,
        slug: acceptSlugs[transfer.id]?.trim() || undefined,
      });
      setIncomingTransfers((prev) => prev.filter((item) => item.id !== transfer.id));
      setAcceptSlugs((prev) => {
        const next = { ...prev };
        delete next[transfer.id];
        return next;
      });
      // The moved project now belongs to the caller; refresh so it appears.
      void loadPage(0);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof GalleryError && err.code === "slug-conflict") {
        // Offer the current slug for editing, then let the next Accept retry.
        setAcceptSlugs((prev) => ({ ...prev, [transfer.id]: prev[transfer.id] ?? transfer.slug }));
      }
      setManageError(galleryErrorMessage(err, t, oauthSupported));
    } finally {
      setManageBusyId(null);
    }
  };

  const handleDeclineTransfer = async (transfer: ProjectTransfer) => {
    setManageBusyId(transfer.projectId);
    setManageError(null);
    try {
      const token = await resolveShareRequestToken(trimmedToken);
      await declineProjectTransfer({ token, transferId: transfer.id });
      setIncomingTransfers((prev) => prev.filter((item) => item.id !== transfer.id));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setManageError(galleryErrorMessage(err, t, oauthSupported));
    } finally {
      setManageBusyId(null);
    }
  };

  // Runs from the transfer dialog. Resolves with what happened so the dialog
  // knows whether to close; throws for the dialog to render the message.
  const handleRequestTransfer = async (
    target: ProjectTransferTarget,
    slug: string,
  ): Promise<"pending" | "accepted"> => {
    if (!transferProject) throw new Error("no project selected");
    const token = await resolveShareRequestToken(trimmedToken);
    const result = await requestProjectTransfer({
      token,
      projectId: transferProject.id,
      target,
      slug: slug.trim() || undefined,
    });
    if (result.transfer.status === "pending") {
      setOutgoingTransfers((prev) => [...prev, result.transfer]);
      return "pending";
    }
    // An organization transfer applies immediately, so the project leaves
    // "My projects"; reload to reflect that.
    void loadPage(0);
    return "accepted";
  };

  const trimmedQuery = query.trim().toLowerCase();
  const visibleProjects = trimmedQuery
    ? projects.filter((p) => searchHaystack(p).includes(trimmedQuery))
    : projects;

  // Fetch the next page shortly before the end of the gallery scrolls into
  // view. Recreating the observer after each request also prevents a sentinel
  // that remains visible from starting the same page more than once.
  useEffect(() => {
    const root = scrollContainerRef.current;
    const sentinel = loadMoreSentinelRef.current;
    if (!open || !root || !sentinel || !hasMore || trimmedQuery || status !== "idle") return;

    const generation = reloadGenerationRef.current;
    return observeGalleryEnd({
      root,
      sentinel,
      generation,
      currentGeneration: () => reloadGenerationRef.current,
      isLoading: () => abortRef.current !== null,
      onLoad: () => void loadPage(rawOffset),
    });
  }, [hasMore, loadPage, open, rawOffset, status, trimmedQuery]);

  const showInitialSpinner = status === "loading" && projects.length === 0;
  const showEmpty = status !== "loading" && !error && visibleProjects.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={dialogRef}
        className="max-h-[85vh] max-w-4xl"
        style={
          dialogSize
            ? {
                width: dialogSize.width,
                height: dialogSize.height,
                maxWidth: "none",
                maxHeight: "none",
              }
            : undefined
        }
        bodyClassName="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4 sm:p-6"
        resizeHandle={
          <div
            role="separator"
            aria-label={t("gallery.resizeDialog")}
            title={t("gallery.resizeDialog")}
            onPointerDown={startDialogResize}
            className="absolute bottom-0 right-0 z-10 hidden h-5 w-5 cursor-nwse-resize touch-none select-none text-muted-foreground hover:text-foreground md:block"
          >
            <svg viewBox="0 0 16 16" className="h-full w-full" aria-hidden="true">
              <path
                d="M11 15L15 11M6 15L15 6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </div>
        }
      >
        <DialogHeader>
          <DialogTitle>{t("gallery.title")}</DialogTitle>
          <DialogDescription>
            {t("gallery.description", { shareHost: shareHostLabel() })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex w-full gap-1 rounded-md bg-muted p-1 sm:w-auto sm:self-start">
          <ScopeTab
            active={effectiveScope === "featured"}
            onClick={() => selectScope("featured")}
            icon={<Star className="h-3.5 w-3.5" />}
            label={t("gallery.scopeFeatured")}
          />
          <ScopeTab
            active={effectiveScope === "all"}
            onClick={() => selectScope("all")}
            icon={<Globe2 className="h-3.5 w-3.5" />}
            label={t("gallery.scopeAll")}
          />
          {hasToken ? (
            <>
              <ScopeTab
                active={effectiveScope === "organizations"}
                onClick={() => selectScope("organizations")}
                icon={<Users className="h-3.5 w-3.5" />}
                label={t("gallery.scopeOrganizations")}
              />
              <ScopeTab
                active={effectiveScope === "groups"}
                onClick={() => selectScope("groups")}
                icon={<UserPlus className="h-3.5 w-3.5" />}
                label={t("gallery.scopeGroups")}
              />
              <ScopeTab
                active={effectiveScope === "mine"}
                onClick={() => selectScope("mine")}
                icon={<User className="h-3.5 w-3.5" />}
                label={t("gallery.scopeMine")}
              />
            </>
          ) : null}
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("gallery.searchPlaceholder")}
            className="ps-8"
            disabled={projects.length === 0 && status !== "idle"}
          />
        </div>

        {!hasToken ? (
          oauthSupported ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{t("gallery.signedOutHint", { shareHost: shareHostLabel() })}</span>
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
                {oauthPending
                  ? t("share.oauthSigningIn")
                  : t("share.oauthSignIn", { shareHost: shareHostLabel() })}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("gallery.signedOutHint", { shareHost: shareHostLabel() })}
            </p>
          )
        ) : null}

        {openError ? (
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{openError}</span>
          </p>
        ) : null}

        {manageError ? (
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{manageError}</span>
          </p>
        ) : null}

        {/* Native overflow scroll (not the Radix ScrollArea) so the area
            reliably scrolls on touch devices: a percentage-height ScrollArea
            viewport does not resolve against this flex-sized parent and would
            grow to its content height instead of scrolling.
            `touch-pan-y` + `overscroll-contain` keep the vertical gesture on
            this element on iOS Safari, where the dialog's scroll-lock
            (react-remove-scroll) otherwise swallows the touchmove. */}
        <div
          ref={scrollContainerRef}
          className="-mx-1 min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-1 [-webkit-overflow-scrolling:touch]"
        >
          {effectiveScope === "mine" && incomingTransfers.length > 0 ? (
            <div className="mb-3 space-y-2">
              {incomingTransfers.map((transfer) => (
                <div
                  key={transfer.id}
                  className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-2 text-xs"
                >
                  <span className="min-w-0 flex-1">
                    {t("gallery.transferIncoming", {
                      from: transfer.fromUsername ?? "",
                      title: transfer.projectTitle,
                    })}
                  </span>
                  {acceptSlugs[transfer.id] !== undefined ? (
                    <div className="flex w-full flex-col gap-1 sm:w-auto">
                      <Input
                        value={acceptSlugs[transfer.id]}
                        onChange={(event) =>
                          setAcceptSlugs((prev) => ({
                            ...prev,
                            [transfer.id]: event.target.value,
                          }))
                        }
                        aria-label={t("gallery.transferSlug")}
                        className="h-8 sm:w-48"
                      />
                      <span className="text-muted-foreground">
                        {t("gallery.transferSlugConflictHint")}
                      </span>
                    </div>
                  ) : null}
                  <Button
                    size="sm"
                    disabled={manageBusyId !== null}
                    onClick={() => void handleAcceptTransfer(transfer)}
                  >
                    {t("gallery.transferAccept")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={manageBusyId !== null}
                    onClick={() => void handleDeclineTransfer(transfer)}
                  >
                    {t("gallery.transferDecline")}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          {showInitialSpinner ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("gallery.loading")}
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="flex items-center gap-1.5 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => loadPage(0)}>
                  {t("gallery.retry")}
                </Button>
                {oauthSupported && (!oauthSignedIn || errorCode === "unauthorized") ? (
                  <Button size="sm" onClick={handleSignIn} disabled={oauthPending}>
                    {oauthPending ? (
                      <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <LogIn className="me-2 h-3.5 w-3.5" />
                    )}
                    {t("share.oauthSignIn", { shareHost: shareHostLabel() })}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <>
              {showEmpty ? (
                <p className="py-16 text-center text-sm text-muted-foreground">
                  {trimmedQuery
                    ? t("gallery.noMatches")
                    : effectiveScope === "mine"
                      ? t("gallery.emptyMine")
                      : effectiveScope === "organizations"
                        ? t("gallery.emptyOrganizations")
                        : effectiveScope === "groups"
                          ? t("gallery.emptyGroups")
                          : effectiveScope === "featured"
                            ? t("gallery.emptyFeatured")
                            : t("gallery.empty")}
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {visibleProjects.map((project) => (
                    <GalleryCard
                      key={project.id}
                      project={project}
                      token={requestToken}
                      openingAction={openingState?.id === project.id ? openingState.action : null}
                      disabled={openingState !== null}
                      onOpen={() => void handleOpen(project)}
                      onOpenCopy={() => void handleOpen(project, { asCopy: true })}
                      manage={
                        effectiveScope === "mine"
                          ? {
                              pendingTransfer:
                                outgoingTransfers.find((item) => item.projectId === project.id) ??
                                null,
                              busy: manageBusyId === project.id,
                              onToggleDeleteProtection: () =>
                                void handleToggleDeleteProtection(project),
                              onTransfer: () => setTransferProject(project),
                              onCancelTransfer: () => {
                                const pending = outgoingTransfers.find(
                                  (item) => item.projectId === project.id,
                                );
                                if (pending) void handleCancelTransfer(pending);
                              },
                            }
                          : undefined
                      }
                    />
                  ))}
                </div>
              )}
              {hasMore && !trimmedQuery ? (
                <div
                  ref={loadMoreSentinelRef}
                  className="flex min-h-12 items-center justify-center py-4"
                >
                  {status === "loadingMore" ? (
                    <span className="flex items-center text-sm text-muted-foreground">
                      <Loader2 className="me-2 h-4 w-4 animate-spin" />
                      {t("gallery.loadingMore")}
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (abortRef.current === null) void loadPage(rawOffset);
                      }}
                    >
                      {t("gallery.loadMore")}
                    </Button>
                  )}
                </div>
              ) : null}
            </>
          )}
        </div>
      </DialogContent>
      <TransferProjectDialog
        project={transferProject}
        // Only organizations the caller administers can receive a project, and
        // one the project is already in is not a destination.
        organizations={organizations.filter(
          (org) => org.role === "administrator" && org.id !== transferProject?.organization?.id,
        )}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setTransferProject(null);
        }}
        onSubmit={handleRequestTransfer}
      />
    </Dialog>
  );
}

function ScopeTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="sm"
      className="flex-1 gap-1.5 sm:flex-none"
      onClick={onClick}
      aria-pressed={active}
    >
      {icon}
      {label}
    </Button>
  );
}

/** A small badge marking non-public projects; public renders nothing. */
function VisibilityBadge({ visibility }: { visibility: string }) {
  const { t } = useTranslation();
  if (visibility !== "unlisted" && visibility !== "private" && visibility !== "organization") {
    return null;
  }
  const isPrivate = visibility === "private";
  const isOrganization = visibility === "organization";
  return (
    <span className="absolute start-1.5 top-1.5 flex items-center gap-1 rounded bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-foreground shadow-sm">
      {isPrivate ? (
        <Lock className="h-2.5 w-2.5" />
      ) : isOrganization ? (
        <Users className="h-2.5 w-2.5" />
      ) : (
        <EyeOff className="h-2.5 w-2.5" />
      )}
      {isPrivate
        ? t("gallery.visibilityPrivate")
        : isOrganization
          ? t("gallery.visibilityOrganization")
          : t("gallery.visibilityUnlisted")}
    </span>
  );
}

/** Owner-only controls shown on a card in the "My projects" scope. */
interface GalleryCardManage {
  pendingTransfer: ProjectTransfer | null;
  busy: boolean;
  onToggleDeleteProtection: () => void;
  onTransfer: () => void;
  onCancelTransfer: () => void;
}

interface GalleryCardProps {
  project: SharedProject;
  token: string;
  openingAction: "open" | "copy" | null;
  disabled: boolean;
  onOpen: () => void;
  onOpenCopy: () => void;
  manage?: GalleryCardManage;
}

function GalleryCard({
  project,
  token,
  openingAction,
  disabled,
  onOpen,
  onOpenCopy,
  manage,
}: GalleryCardProps) {
  const { t } = useTranslation();
  const [thumbBroken, setThumbBroken] = useState(false);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setThumbBroken(false);
    setThumbnailUrl(null);
    // A protected thumbnail waits for the dialog to resolve its credential.
    if (!token && project.visibility !== "public" && project.visibility !== "unlisted") {
      return () => controller.abort();
    }
    void loadSharedProjectThumbnail(project, { token, signal: controller.signal })
      .then((result) => {
        if (!result) return;
        if (controller.signal.aborted) {
          if (result.objectUrl) URL.revokeObjectURL(result.url);
          return;
        }
        objectUrl = result.objectUrl ? result.url : null;
        setThumbnailUrl(result.url);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.error("Failed to load shared project thumbnail", error);
          setThumbBroken(true);
        }
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [project, token]);

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border bg-card">
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        className="group relative block aspect-video w-full overflow-hidden bg-muted disabled:cursor-not-allowed"
        title={t("gallery.open")}
      >
        {thumbnailUrl && !thumbBroken ? (
          <img
            src={thumbnailUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
            onError={() => setThumbBroken(true)}
          />
        ) : (
          <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
            <ImageOff className="h-6 w-6" />
            <span className="text-xs">{t("gallery.noThumbnail")}</span>
          </span>
        )}
        {openingAction !== null ? (
          <span className="absolute inset-0 flex items-center justify-center bg-background/60">
            <Loader2 className="h-5 w-5 animate-spin" />
          </span>
        ) : null}
        <VisibilityBadge visibility={project.visibility} />
      </button>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <p className="truncate text-sm font-medium" title={project.title || t("gallery.untitled")}>
          {project.title || t("gallery.untitled")}
        </p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {project.username ? (
            <span className="truncate">{t("gallery.byAuthor", { author: project.username })}</span>
          ) : null}
          <span className="ms-auto flex shrink-0 items-center gap-1">
            <Eye className="h-3 w-3" />
            {t("gallery.views", { count: project.views })}
          </span>
        </div>

        {manage ? (
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {project.deleteProtected === true ? (
              <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                <ShieldCheck className="h-3 w-3" />
                {t("gallery.deleteProtectedBadge")}
              </span>
            ) : null}
            {project.deleteProtected !== null ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-1.5"
                aria-pressed={project.deleteProtected}
                aria-label={t("gallery.preventDeletion")}
                title={t("gallery.preventDeletion")}
                disabled={manage.busy}
                onClick={manage.onToggleDeleteProtection}
              >
                {project.deleteProtected ? (
                  <Shield className="h-3.5 w-3.5" />
                ) : (
                  <ShieldOff className="h-3.5 w-3.5" />
                )}
              </Button>
            ) : null}
            {manage.pendingTransfer ? (
              <>
                <span className="min-w-0 flex-1 truncate">
                  {t("gallery.transferPendingTo", {
                    target: manage.pendingTransfer.toUsername ?? "",
                  })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 px-1.5 text-xs"
                  disabled={manage.busy}
                  onClick={manage.onCancelTransfer}
                >
                  {t("gallery.transferCancel")}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 px-1.5"
                aria-label={t("gallery.transfer")}
                title={t("gallery.transfer")}
                disabled={manage.busy}
                onClick={manage.onTransfer}
              >
                <ArrowRightLeft className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-1.5 sm:flex-nowrap">
          <Button size="sm" className="flex-1" disabled={disabled} onClick={onOpen}>
            {openingAction === "open" ? (
              <>
                <Loader2 className="me-2 h-4 w-4 animate-spin" />
                {t("gallery.opening")}
              </>
            ) : (
              t("gallery.open")
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            disabled={disabled}
            onClick={onOpenCopy}
          >
            {openingAction === "copy" ? (
              <>
                <Loader2 className="me-2 h-4 w-4 animate-spin" />
                {t("gallery.openingCopy")}
              </>
            ) : (
              t("gallery.openCopy")
            )}
          </Button>
          {project.projectUrl ? (
            <Button
              size="sm"
              variant="outline"
              aria-label={t("gallery.openOnWeb")}
              title={t("gallery.openOnWeb")}
              onClick={() => void openExternalLink(project.projectUrl)}
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
