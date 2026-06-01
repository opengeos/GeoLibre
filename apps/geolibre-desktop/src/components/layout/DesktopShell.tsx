import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { MapCanvas } from "@geolibre/map";
import {
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  isTauri,
  loadDroppedVectorFiles,
  loadDroppedVectorPaths,
} from "../../lib/tauri-io";
import { registerMbtilesProtocol } from "../../lib/mbtiles";
import { registerXyzTileProtocol } from "../../lib/xyz-url";
import { AttributeTable } from "../panels/AttributeTable";
import { LayerPanel } from "../panels/LayerPanel";
import { StylePanel } from "../panels/StylePanel";
import { ProcessingDialog } from "../processing/ProcessingDialog";
import { StatusBar } from "./StatusBar";
import { TopToolbar } from "./TopToolbar";
import type { LayoutOptions } from "../../hooks/useLayoutOptions";
import type { ThemeMode } from "../../hooks/useThemeMode";
import type { ProjectUrlLoadState } from "../../hooks/useProjectUrlLoader";

interface DesktopShellProps {
  layoutOptions: LayoutOptions;
  projectUrlLoadState?: ProjectUrlLoadState;
  themeMode: ThemeMode;
  onToggleThemeMode: () => void;
}

function hasDroppedFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function layerNameFromPath(path: string): string {
  return fileNameFromPath(path).replace(/\.[^.]+$/, "") || "Vector Layer";
}

type ImportedVectorLayer = Awaited<
  ReturnType<typeof loadDroppedVectorFiles>
>[number];

const DEFAULT_SIDE_PANEL_WIDTH = 256;
const MIN_SIDE_PANEL_WIDTH = 180;
const MAX_SIDE_PANEL_WIDTH = 460;
const PANEL_RESIZE_START_EVENT = "geolibre:panel-resize-start";
const PANEL_RESIZE_END_EVENT = "geolibre:panel-resize-end";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type ShellStyle = CSSProperties &
  Record<"--layer-panel-width" | "--style-panel-width", string>;

export function DesktopShell({
  layoutOptions,
  projectUrlLoadState,
  themeMode,
  onToggleThemeMode,
}: DesktopShellProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const verticalResizeGuideRef = useRef<HTMLDivElement>(null);
  const mapControllerRef = useRef<MapController | null>(null);
  const dragDepthRef = useRef(0);
  const dropMessageTimeoutRef = useRef<number | null>(null);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [dropMessage, setDropMessage] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [layerPanelWidth, setLayerPanelWidth] = useState(
    DEFAULT_SIDE_PANEL_WIDTH,
  );
  const [stylePanelWidth, setStylePanelWidth] = useState(
    DEFAULT_SIDE_PANEL_WIDTH,
  );
  const deferPanelResize = isTauri();
  const shellStyle: ShellStyle = {
    "--layer-panel-width": `${layerPanelWidth}px`,
    "--style-panel-width": `${stylePanelWidth}px`,
  };

  const clearDropMessageLater = useCallback(() => {
    if (dropMessageTimeoutRef.current !== null) {
      window.clearTimeout(dropMessageTimeoutRef.current);
    }
    dropMessageTimeoutRef.current = window.setTimeout(() => {
      dropMessageTimeoutRef.current = null;
      setDropMessage(null);
      setDropError(null);
    }, 4000);
  }, []);

  useEffect(() => {
    if (isTauri()) {
      registerMbtilesProtocol();
      registerXyzTileProtocol();
    }
  }, []);

  useEffect(() => {
    return () => {
      if (dropMessageTimeoutRef.current !== null) {
        window.clearTimeout(dropMessageTimeoutRef.current);
      }
    };
  }, []);

  const addImportedVectorLayers = useCallback(
    (importedLayers: ImportedVectorLayer[]) => {
      let lastLayerId: string | null = null;
      for (const layer of importedLayers) {
        lastLayerId = addGeoJsonLayer(
          layerNameFromPath(layer.path),
          layer.data,
          layer.path,
        );
      }

      const importedLayer = useAppStore
        .getState()
        .layers.find((layer) => layer.id === lastLayerId);
      if (importedLayer) mapControllerRef.current?.fitLayer(importedLayer);
    },
    [addGeoJsonLayer],
  );

  const finishVectorDrop = useCallback(
    (importedLayers: ImportedVectorLayer[]) => {
      if (!importedLayers.length) {
        throw new Error("Drop a supported vector file.");
      }
      addImportedVectorLayers(importedLayers);
      setDropMessage(
        `Added ${importedLayers.length} vector layer${
          importedLayers.length === 1 ? "" : "s"
        }.`,
      );
    },
    [addImportedVectorLayers],
  );

  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | null = null;
    let disposed = false;

    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      if (disposed) return;
      void getCurrentWebview()
        .onDragDropEvent(async (event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setIsDraggingFiles(true);
            return;
          }

          if (event.payload.type === "leave") {
            setIsDraggingFiles(false);
            return;
          }

          setIsDraggingFiles(false);
          setDropError(null);
          setDropMessage("Importing vector data...");

          try {
            finishVectorDrop(await loadDroppedVectorPaths(event.payload.paths));
          } catch (error) {
            setDropMessage(null);
            setDropError(
              error instanceof Error
                ? error.message
                : "Could not import files.",
            );
          } finally {
            clearDropMessageLater();
          }
        })
        .then((nextUnlisten) => {
          if (disposed) {
            nextUnlisten();
          } else {
            unlisten = nextUnlisten;
          }
        })
        .catch((error) => {
          console.warn("Could not attach Tauri drag and drop handler", error);
        });
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [clearDropMessageLater, finishVectorDrop]);

  const handleDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFiles(false);
  }, []);

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      if (!hasDroppedFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDraggingFiles(false);
      setDropError(null);
      setDropMessage("Importing vector data...");

      try {
        const importedLayers = await loadDroppedVectorFiles(
          event.dataTransfer.files,
        );
        finishVectorDrop(importedLayers);
      } catch (error) {
        setDropMessage(null);
        setDropError(
          error instanceof Error ? error.message : "Could not import files.",
        );
      } finally {
        clearDropMessageLater();
      }
    },
    [clearDropMessageLater, finishVectorDrop],
  );

  const startLayerPanelResize = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      const startWidth = layerPanelWidth;
      const panelRect =
        event.currentTarget.parentElement?.getBoundingClientRect();
      let nextWidth = startWidth;
      let resizeFrame: number | null = null;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

      const onMouseMove = (moveEvent: MouseEvent) => {
        nextWidth = clamp(
          startWidth + moveEvent.clientX - startX,
          MIN_SIDE_PANEL_WIDTH,
          MAX_SIDE_PANEL_WIDTH,
        );
        if (resizeFrame !== null) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = null;
          if (deferPanelResize) {
            if (verticalResizeGuideRef.current && panelRect) {
              verticalResizeGuideRef.current.style.left = `${
                panelRect.left + nextWidth
              }px`;
              verticalResizeGuideRef.current.classList.remove("hidden");
            }
            return;
          }
          shellRef.current?.style.setProperty(
            "--layer-panel-width",
            `${nextWidth}px`,
          );
        });
      };

      const onMouseUp = () => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        if (resizeFrame !== null) {
          window.cancelAnimationFrame(resizeFrame);
          resizeFrame = null;
        }
        shellRef.current?.style.setProperty(
          "--layer-panel-width",
          `${nextWidth}px`,
        );
        verticalResizeGuideRef.current?.classList.add("hidden");
        setLayerPanelWidth(nextWidth);
        window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [deferPanelResize, layerPanelWidth],
  );

  const startStylePanelResize = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      const startWidth = stylePanelWidth;
      const panelRect =
        event.currentTarget.parentElement?.getBoundingClientRect();
      let nextWidth = startWidth;
      let resizeFrame: number | null = null;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

      const onMouseMove = (moveEvent: MouseEvent) => {
        nextWidth = clamp(
          startWidth + startX - moveEvent.clientX,
          MIN_SIDE_PANEL_WIDTH,
          MAX_SIDE_PANEL_WIDTH,
        );
        if (resizeFrame !== null) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = null;
          if (deferPanelResize) {
            if (verticalResizeGuideRef.current && panelRect) {
              verticalResizeGuideRef.current.style.left = `${
                panelRect.right - nextWidth
              }px`;
              verticalResizeGuideRef.current.classList.remove("hidden");
            }
            return;
          }
          shellRef.current?.style.setProperty(
            "--style-panel-width",
            `${nextWidth}px`,
          );
        });
      };

      const onMouseUp = () => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        if (resizeFrame !== null) {
          window.cancelAnimationFrame(resizeFrame);
          resizeFrame = null;
        }
        shellRef.current?.style.setProperty(
          "--style-panel-width",
          `${nextWidth}px`,
        );
        verticalResizeGuideRef.current?.classList.add("hidden");
        setStylePanelWidth(nextWidth);
        window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [deferPanelResize, stylePanelWidth],
  );

  return (
    <div
      ref={shellRef}
      className="relative flex h-full min-w-0 flex-col overflow-hidden bg-background"
      style={shellStyle}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <TopToolbar
        compact={layoutOptions.compact}
        mapControllerRef={mapControllerRef}
        showLabels={layoutOptions.toolbarLabels}
        showProjectInfo={layoutOptions.showProjectInfo}
        themeMode={themeMode}
        onToggleThemeMode={onToggleThemeMode}
      />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {layoutOptions.panelsVisible ? (
          <LayerPanel
            mapControllerRef={mapControllerRef}
            onResizeStart={startLayerPanelResize}
          />
        ) : null}
        <main
          className={`relative min-w-0 flex-1 overflow-hidden ${
            layoutOptions.compact ? "min-h-0" : "min-h-72 md:min-h-0"
          }`}
        >
          <MapCanvas controllerRef={mapControllerRef} />
        </main>
        {layoutOptions.panelsVisible ? (
          <StylePanel onResizeStart={startStylePanelResize} />
        ) : null}
      </div>
      {layoutOptions.panelsVisible ? <AttributeTable /> : null}
      <StatusBar compact={layoutOptions.compact} />
      <ProcessingDialog mapControllerRef={mapControllerRef} />
      <div
        ref={verticalResizeGuideRef}
        className="pointer-events-none fixed bottom-7 top-11 z-50 hidden w-px bg-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.25)]"
      />
      {isDraggingFiles ? (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <div className="rounded-md border bg-background px-4 py-3 text-sm font-medium shadow-lg">
            Drop vector files to add layers
          </div>
        </div>
      ) : null}
      {projectUrlLoadState?.message || projectUrlLoadState?.error ? (
        <div
          aria-live="polite"
          className={`pointer-events-none absolute left-1/2 top-14 z-50 max-w-[min(90vw,32rem)] -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-center text-sm shadow-lg ${
            projectUrlLoadState.error ? "text-destructive" : "text-foreground"
          }`}
        >
          {projectUrlLoadState.error ?? projectUrlLoadState.message}
        </div>
      ) : null}
      {dropMessage || dropError ? (
        <div
          aria-live="polite"
          className={`pointer-events-none absolute bottom-10 left-1/2 z-50 -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-sm shadow-lg ${
            dropError ? "text-destructive" : "text-foreground"
          }`}
        >
          {dropError ?? dropMessage}
        </div>
      ) : null}
    </div>
  );
}
