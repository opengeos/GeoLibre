import { ImageOff, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { STARTER_PROJECTS, type StarterProject } from "../../lib/starter-projects";
import { CollapsibleSection } from "../CollapsibleSection";

interface StarterProjectCardProps {
  example: StarterProject;
  loading: boolean;
  disabled: boolean;
  onOpen: (example: StarterProject) => void;
}

function StarterProjectCard({ example, loading, disabled, onOpen }: StarterProjectCardProps) {
  // Offline (or a moved image) leaves the thumbnail unloadable; show a neutral
  // placeholder rather than the browser's broken-image glyph.
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      aria-busy={loading}
      onClick={() => onOpen(example)}
      className="flex items-start gap-2.5 rounded-md border p-2 text-start transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      data-testid={`starter-project-${example.id}`}
      data-starter-project=""
    >
      <div className="relative flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
        {thumbnailFailed ? (
          <ImageOff className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        ) : (
          <img
            src={example.thumbnailUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setThumbnailFailed(true)}
          />
        )}
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          </div>
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-tight">{example.title}</p>
        <p className="line-clamp-2 text-xs text-muted-foreground">{example.description}</p>
      </div>
    </button>
  );
}

interface StarterProjectsSectionProps {
  /**
   * Load a starter project from its raw `.geolibre.json` URL. Resolves true
   * once loaded and false when the open was cancelled; rejects on failure so
   * the section can show the error inline.
   */
  onOpenExample: (projectUrl: string) => Promise<boolean>;
  /** Called once an example has loaded, so the dialog can close. */
  onOpened: () => void;
  /**
   * Mount expanded, scrolled into view, with the first example focused (the
   * "Open Starter Examples" command). Only read on mount.
   */
  expanded?: boolean;
}

/**
 * The New Project dialog's collapsible Examples section: the bundled starter
 * projects as thumbnail cards. Owns the per-open loading and error state; the
 * dialog unmounts it on close, which resets both.
 */
export function StarterProjectsSection({
  onOpenExample,
  onOpened,
  expanded = false,
}: StarterProjectsSectionProps) {
  const { t } = useTranslation();
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  // Read once: the section is remounted on every dialog open.
  const [expandOnMount] = useState(expanded);
  useEffect(() => {
    if (!expandOnMount) return;
    // Wait a frame so the dialog's own open auto-focus has run; otherwise it
    // would move focus straight back to the first field.
    const frame = requestAnimationFrame(() => {
      const section = sectionRef.current;
      if (!section) return;
      section.scrollIntoView({ block: "start" });
      section.querySelector<HTMLButtonElement>("button[data-starter-project]")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [expandOnMount]);

  if (STARTER_PROJECTS.length === 0) return null;

  const handleOpen = async (example: StarterProject) => {
    if (loadingId) return;
    setLoadingId(example.id);
    setError(null);
    try {
      if (await onOpenExample(example.projectUrl)) onOpened();
      else setLoadingId(null);
    } catch (err) {
      // Offline, a moved file, or a project that fails to parse: keep the
      // dialog open on the current project and say which example failed.
      console.error(`Failed to open starter project ${example.projectUrl}`, err);
      setError({
        title: example.title,
        detail: err instanceof Error ? err.message : String(err),
      });
      setLoadingId(null);
    }
  };

  return (
    <div ref={sectionRef}>
      <CollapsibleSection title={t("newProject.examples")} defaultOpen={expandOnMount}>
        <p className="text-xs text-muted-foreground">{t("newProject.examplesDescription")}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {STARTER_PROJECTS.map((example) => (
            <StarterProjectCard
              key={example.id}
              example={example}
              loading={loadingId === example.id}
              disabled={loadingId !== null}
              onOpen={(item) => void handleOpen(item)}
            />
          ))}
        </div>
        {error ? (
          <div role="alert" className="space-y-0.5 text-xs text-destructive">
            <p className="font-medium">
              {t("newProject.exampleOpenFailed", { title: error.title })}
            </p>
            <p className="break-words">{error.detail}</p>
          </div>
        ) : null}
      </CollapsibleSection>
    </div>
  );
}
