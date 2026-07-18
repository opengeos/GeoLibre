import { useAppStore } from "@geolibre/core";
import { Button } from "@geolibre/ui";
import { Loader2, NotebookPen, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { MapController } from "@geolibre/map";
import { getIsMobileViewport } from "../../hooks/useIsMobileViewport";
import { useNotebookBridge } from "../../hooks/useNotebookBridge";
import { useNotebookThemeSync } from "../../hooks/useNotebookThemeSync";
import type { ThemeMode } from "../../hooks/useThemeMode";
import { isTauri } from "../../lib/is-tauri";
import { startJupyterServer } from "../../lib/jupyter";

/**
 * Resolve the notebook iframe URL for the current environment:
 *
 * - **Desktop (Tauri):** start (or reuse) the uv-managed JupyterLab server and
 *   embed its token-authenticated `/lab` URL.
 * - **Web:** load the self-hosted JupyterLite site (in-browser Pyodide kernel)
 *   built by `npm run build:jupyterlite` into `public/jupyterlite/`.
 */
async function resolveNotebookUrl(): Promise<string> {
  if (isTauri()) {
    const info = await startJupyterServer();
    return `${info.url}/lab?token=${encodeURIComponent(info.token)}`;
  }
  return `${import.meta.env.BASE_URL}jupyterlite/lab/index.html`;
}

interface NotebookPanelProps {
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  mapControllerRef: RefObject<MapController | null>;
  themeMode: ThemeMode;
}

/**
 * A right-docked, resizable, collapsible panel that hosts a Jupyter notebook
 * beside the map. Like the Style panel, it collapses to a thin rail and fully
 * unmounts when closed. The single `<iframe>` is kept in a stable tree position
 * (only its visibility toggles) so the live kernel and notebook state survive a
 * collapse→expand without reloading.
 *
 * The iframe points at the self-hosted JupyterLite build (web) or a
 * Tauri-launched JupyterLab server (desktop), and notebook cells can drive the
 * live map via {@link useNotebookBridge}.
 *
 * @param onResizeStart - Pointer handler for the left-edge resize splitter,
 *   supplied by DesktopShell (mirrors the Style panel's resize wiring).
 * @param mapControllerRef - Ref to the live map controller, forwarded to the
 *   notebook scripting bridge so notebook cells can drive the map.
 * @param themeMode - The app's current theme, mirrored into the notebook.
 */
export function NotebookPanel({ onResizeStart, mapControllerRef, themeMode }: NotebookPanelProps) {
  const { t } = useTranslation();
  const setNotebookOpen = useAppStore((s) => s.setNotebookOpen);
  const [isCollapsed, setIsCollapsed] = useState(getIsMobileViewport);
  const [loaded, setLoaded] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Let notebook cells drive the live map via the shared scripting protocol.
  useNotebookBridge(iframeRef, mapControllerRef);
  // Mirror the app's light/dark theme into the embedded notebook.
  useNotebookThemeSync(iframeRef, themeMode, loaded);

  // Resolve the iframe URL once on mount (desktop starts the JupyterLab server,
  // which can take a moment on first run while uv syncs the environment).
  useEffect(() => {
    let cancelled = false;
    resolveNotebookUrl()
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A failed Tauri command rejects with its Rust error *string*, not an
        // Error, so surface that directly; fall back to the generic message
        // only when there is nothing useful to show.
        const message =
          err instanceof Error
            ? err.message
            : typeof err === "string" && err
              ? err
              : t("notebook.loadFailed");
        setError(message);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  return (
    <aside
      aria-label={t("notebook.title")}
      className={
        isCollapsed
          ? "flex h-11 w-full shrink-0 items-center gap-2 border-t bg-card px-2 md:h-auto md:w-11 md:flex-col md:border-s md:border-t-0 md:py-2"
          : "relative flex h-72 w-full shrink-0 flex-col border-t bg-card md:h-auto md:w-[var(--notebook-panel-width)] md:border-s md:border-t-0"
      }
    >
      {isCollapsed ? (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={t("notebook.expand")}
            aria-label={t("notebook.expand")}
            onClick={() => setIsCollapsed(false)}
          >
            <PanelRightOpen className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2 text-muted-foreground md:mt-3 md:flex-col">
            <NotebookPen className="h-4 w-4" />
            <span className="text-[10px] font-semibold uppercase tracking-wide md:[writing-mode:vertical-rl] md:rotate-180">
              {t("notebook.title")}
            </span>
          </div>
        </>
      ) : (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("notebook.resize")}
            className="absolute -start-1 top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none select-none border-s border-transparent hover:border-primary md:block"
            onPointerDown={onResizeStart}
          />
          <div className="flex items-center gap-2 border-b px-3 py-1.5">
            <NotebookPen className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">{t("notebook.title")}</span>
            <div className="ms-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title={t("notebook.collapse")}
                aria-label={t("notebook.collapse")}
                onClick={() => setIsCollapsed(true)}
              >
                <PanelRightClose className="h-4 w-4" />
              </Button>
              {/* Close just unmounts the panel. On desktop the JupyterLab
                  server (started via startJupyterServer) is intentionally left
                  running for the app's lifetime — so reopening is instant and
                  kernel state is preserved — and is torn down on app exit by
                  the Rust JupyterProcess::Drop, not here. */}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title={t("notebook.close")}
                aria-label={t("notebook.close")}
                onClick={() => setNotebookOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </>
      )}
      {/* A single iframe that stays mounted across collapse (only hidden) so the
          live kernel and notebook state are preserved. */}
      <div className={isCollapsed ? "hidden" : "relative min-h-0 flex-1"}>
        {error ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center px-4 text-center text-xs text-destructive">
            {error}
          </div>
        ) : !loaded ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-card text-xs text-muted-foreground">
            <Loader2 className="me-2 h-4 w-4 animate-spin" />
            {t("notebook.loading")}
          </div>
        ) : null}
        {src ? (
          <iframe
            ref={iframeRef}
            title={t("notebook.title")}
            src={src}
            className="h-full w-full border-0"
            onLoad={() => setLoaded(true)}
          />
        ) : null}
      </div>
    </aside>
  );
}
