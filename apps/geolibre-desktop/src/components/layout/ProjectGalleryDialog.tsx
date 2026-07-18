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
  Eye,
  EyeOff,
  ExternalLink,
  Globe2,
  ImageOff,
  Loader2,
  Lock,
  Search,
  Star,
  User,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import { openExternalLink } from "../../lib/open-external";
import {
  fetchMyProjects,
  fetchSharedProjects,
  GalleryError,
  projectOpenToken,
  type SharedProject,
} from "../../lib/share-gallery";
import type { TFunction } from "i18next";

type GalleryScope = "featured" | "all" | "mine";

interface ProjectGalleryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Load a project from its raw `.geolibre.json` URL into the app. `authToken`
   * is passed for the user's own (unlisted/private) projects so the share host
   * authorizes the fetch. Resolves on success and rejects with a descriptive
   * error the dialog surfaces inline.
   */
  onOpenProject: (rawJsonUrl: string, authToken?: string) => Promise<void>;
}

// Page size for each listing request. The endpoint paginates by limit + offset.
const PAGE_SIZE = 24;

/** Lowercased haystack for the client-side title/author/tag filter. */
function searchHaystack(project: SharedProject): string {
  return [project.title, project.username, ...project.tags].join(" ").toLowerCase();
}

/**
 * Translate a fetch error into a localized message. The gallery library throws
 * coded {@link GalleryError}s (it can't call `t()`); the UI maps each code to a
 * catalog string here.
 */
function galleryErrorMessage(error: unknown, t: TFunction): string {
  if (error instanceof GalleryError) {
    switch (error.code) {
      case "timeout":
        return t("gallery.errorTimeout");
      case "network":
        return t("gallery.errorNetwork");
      case "invalid-response":
        return t("gallery.errorInvalidResponse");
      case "unauthorized":
        return t("gallery.errorUnauthorized");
      case "username-required":
        return t("gallery.errorUsernameRequired");
      case "http":
        return t("gallery.errorHttp", { status: error.status ?? 0 });
    }
  }
  return error instanceof Error ? error.message : t("gallery.errorFallback");
}

/**
 * Browse public projects shared on share.geolibre.app and open one in GeoLibre.
 *
 * The listing endpoint only paginates (no server-side search), so this loads
 * pages on demand via "Load more" and filters the already-loaded set in the
 * browser.
 */
export function ProjectGalleryDialog({
  open,
  onOpenChange,
  onOpenProject,
}: ProjectGalleryDialogProps) {
  const { t } = useTranslation();
  const trimmedToken = (useDesktopSettingsStore((s) => s.desktopSettings.shareToken) ?? "").trim();
  const hasToken = trimmedToken.length > 0;
  const [scope, setScope] = useState<GalleryScope>("featured");
  const [projects, setProjects] = useState<SharedProject[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "loadingMore">("idle");
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  // Next-page offset tracked from the server's raw record count, not the
  // filtered `projects.length` (normalizeProject may drop records, which would
  // otherwise undershoot the offset and re-deliver already-seen entries).
  const [rawOffset, setRawOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Without a token, the "My projects" scope isn't available; fall back to the
  // featured tab.
  const effectiveScope: GalleryScope = scope === "mine" && !hasToken ? "featured" : scope;

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
      try {
        if (effectiveScope === "mine") {
          // "My projects" returns the full set (no pagination) and includes the
          // owner's unlisted/private projects via the API token.
          const mine = await fetchMyProjects({
            token: trimmedToken,
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setProjects(mine);
          setHasMore(false);
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
        setError(galleryErrorMessage(err, t));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (!controller.signal.aborted) setStatus("idle");
      }
    },
    [t, effectiveScope, trimmedToken],
  );

  // Reload from the first page when the dialog opens or the scope changes (the
  // `loadPage` identity changes with scope); reset transient state and abort any
  // in-flight request when it closes.
  useEffect(() => {
    if (open) {
      setProjects([]);
      setQuery("");
      setOpeningId(null);
      setOpenError(null);
      setHasMore(false);
      setRawOffset(0);
      void loadPage(0);
    } else {
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open, loadPage]);

  const handleOpen = async (project: SharedProject) => {
    setOpeningId(project.id);
    setOpenError(null);
    try {
      await onOpenProject(
        project.rawJsonUrl,
        effectiveScope === "mine" ? projectOpenToken(project, trimmedToken) : undefined,
      );
      onOpenChange(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("Failed to open gallery project", err);
      setOpenError(err instanceof Error ? err.message : t("gallery.openError"));
    } finally {
      setOpeningId(null);
    }
  };

  const trimmedQuery = query.trim().toLowerCase();
  const visibleProjects = trimmedQuery
    ? projects.filter((p) => searchHaystack(p).includes(trimmedQuery))
    : projects;

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
          <DialogDescription>{t("gallery.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex w-full gap-1 rounded-md bg-muted p-1 sm:w-auto sm:self-start">
          <ScopeTab
            active={effectiveScope === "featured"}
            onClick={() => setScope("featured")}
            icon={<Star className="h-3.5 w-3.5" />}
            label={t("gallery.scopeFeatured")}
          />
          <ScopeTab
            active={effectiveScope === "all"}
            onClick={() => setScope("all")}
            icon={<Globe2 className="h-3.5 w-3.5" />}
            label={t("gallery.scopeAll")}
          />
          {hasToken ? (
            <ScopeTab
              active={effectiveScope === "mine"}
              onClick={() => setScope("mine")}
              icon={<User className="h-3.5 w-3.5" />}
              label={t("gallery.scopeMine")}
            />
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
          <p className="text-xs text-muted-foreground">{t("gallery.signedOutHint")}</p>
        ) : null}

        {openError ? (
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{openError}</span>
          </p>
        ) : null}

        {/* Native overflow scroll (not the Radix ScrollArea) so the area
            reliably scrolls on touch devices: a percentage-height ScrollArea
            viewport does not resolve against this flex-sized parent and would
            grow to its content height instead of scrolling.
            `touch-pan-y` + `overscroll-contain` keep the vertical gesture on
            this element on iOS Safari, where the dialog's scroll-lock
            (react-remove-scroll) otherwise swallows the touchmove. */}
        <div className="-mx-1 min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-1 [-webkit-overflow-scrolling:touch]">
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
              <Button variant="outline" size="sm" onClick={() => loadPage(0)}>
                {t("gallery.retry")}
              </Button>
            </div>
          ) : showEmpty ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              {trimmedQuery
                ? t("gallery.noMatches")
                : effectiveScope === "mine"
                  ? t("gallery.emptyMine")
                  : effectiveScope === "featured"
                    ? t("gallery.emptyFeatured")
                    : t("gallery.empty")}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {visibleProjects.map((project) => (
                  <GalleryCard
                    key={project.id}
                    project={project}
                    opening={openingId === project.id}
                    disabled={openingId !== null}
                    onOpen={() => void handleOpen(project)}
                  />
                ))}
              </div>
              {hasMore && !trimmedQuery ? (
                <div className="flex justify-center py-4">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={status === "loadingMore"}
                    onClick={() => loadPage(rawOffset)}
                  >
                    {status === "loadingMore" ? (
                      <>
                        <Loader2 className="me-2 h-4 w-4 animate-spin" />
                        {t("gallery.loadingMore")}
                      </>
                    ) : (
                      t("gallery.loadMore")
                    )}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </DialogContent>
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
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-1 text-sm font-medium transition-colors sm:flex-none ${
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

/** A small badge marking unlisted/private projects; public renders nothing. */
function VisibilityBadge({ visibility }: { visibility: string }) {
  const { t } = useTranslation();
  if (visibility !== "unlisted" && visibility !== "private") return null;
  const isPrivate = visibility === "private";
  return (
    <span className="absolute start-1.5 top-1.5 flex items-center gap-1 rounded bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-foreground shadow-sm">
      {isPrivate ? <Lock className="h-2.5 w-2.5" /> : <EyeOff className="h-2.5 w-2.5" />}
      {isPrivate ? t("gallery.visibilityPrivate") : t("gallery.visibilityUnlisted")}
    </span>
  );
}

interface GalleryCardProps {
  project: SharedProject;
  opening: boolean;
  disabled: boolean;
  onOpen: () => void;
}

function GalleryCard({ project, opening, disabled, onOpen }: GalleryCardProps) {
  const { t } = useTranslation();
  const [thumbBroken, setThumbBroken] = useState(false);

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border bg-card">
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        className="group relative block aspect-video w-full overflow-hidden bg-muted disabled:cursor-not-allowed"
        title={t("gallery.open")}
      >
        {project.thumbnailUrl && !thumbBroken ? (
          <img
            src={project.thumbnailUrl}
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
        {opening ? (
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

        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" className="flex-1" disabled={disabled} onClick={onOpen}>
            {opening ? (
              <>
                <Loader2 className="me-2 h-4 w-4 animate-spin" />
                {t("gallery.opening")}
              </>
            ) : (
              t("gallery.open")
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
