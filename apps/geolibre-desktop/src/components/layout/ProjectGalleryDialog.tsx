import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  ScrollArea,
} from "@geolibre/ui";
import {
  AlertCircle,
  Eye,
  ExternalLink,
  ImageOff,
  Loader2,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openExternalLink } from "../../lib/open-external";
import {
  fetchSharedProjects,
  type SharedProject,
} from "../../lib/share-gallery";

interface ProjectGalleryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Load a project from its raw `.geolibre.json` URL into the app. Resolves on
   * success and rejects with a descriptive error the dialog surfaces inline.
   */
  onOpenProject: (rawJsonUrl: string) => Promise<void>;
}

// Page size for each listing request. The endpoint paginates by limit + offset.
const PAGE_SIZE = 24;

/** Lowercased haystack for the client-side title/author/tag filter. */
function searchHaystack(project: SharedProject): string {
  return [project.title, project.username, ...project.tags]
    .join(" ")
    .toLowerCase();
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
  const [projects, setProjects] = useState<SharedProject[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "loadingMore">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState("");
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
        const result = await fetchSharedProjects({
          limit: PAGE_SIZE,
          offset,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setProjects((prev) =>
          offset === 0 ? result.projects : [...prev, ...result.projects],
        );
        setHasMore(result.hasMore);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Failed to load project gallery", err);
        setError(
          err instanceof Error ? err.message : t("gallery.errorFallback"),
        );
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (!controller.signal.aborted) setStatus("idle");
      }
    },
    [t],
  );

  // Load the first page when the dialog opens; reset transient state and abort
  // any in-flight request when it closes.
  useEffect(() => {
    if (open) {
      setProjects([]);
      setQuery("");
      setOpeningId(null);
      setOpenError(null);
      setHasMore(false);
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
      await onOpenProject(project.rawJsonUrl);
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
  const showEmpty =
    status !== "loading" && !error && visibleProjects.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col">
        <DialogHeader>
          <DialogTitle>{t("gallery.title")}</DialogTitle>
          <DialogDescription>{t("gallery.description")}</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("gallery.searchPlaceholder")}
            className="pl-8"
            disabled={projects.length === 0 && status !== "idle"}
          />
        </div>

        {openError ? (
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{openError}</span>
          </p>
        ) : null}

        <ScrollArea className="-mx-1 flex-1 px-1">
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
              {trimmedQuery ? t("gallery.noMatches") : t("gallery.empty")}
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
                    onClick={() => loadPage(projects.length)}
                  >
                    {status === "loadingMore" ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
        </ScrollArea>
      </DialogContent>
    </Dialog>
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
      </button>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <p className="truncate text-sm font-medium" title={project.title}>
          {project.title}
        </p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {project.username ? (
            <span className="truncate">
              {t("gallery.byAuthor", { author: project.username })}
            </span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <Eye className="h-3 w-3" />
            {t("gallery.views", { count: project.views })}
          </span>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm"
            className="flex-1"
            disabled={disabled}
            onClick={onOpen}
          >
            {opening ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
