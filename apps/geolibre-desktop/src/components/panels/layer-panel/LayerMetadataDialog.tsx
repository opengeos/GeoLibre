import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useLayer, type GeoLibreLayer } from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  ScrollArea,
  cn,
} from "@geolibre/ui";
import { Copy } from "lucide-react";
import { readRasterInfo } from "../../../lib/raster-info";
import { layerMetadataPayload, rasterInfoUrl, type RasterInfoState } from "./layer-panel-utils";

/**
 * State of the layer metadata dialog: the id of the layer it shows, the copy
 * confirmation, the GeoTIFF header read for rasters, and the user-chosen
 * dialog size (kept across open/close).
 *
 * @returns The dialog state, the JSON it shows, and the copy/resize handlers.
 */
export function useLayerMetadataDialog() {
  // Only the id is held: the record is read live from the store, so a rename,
  // restyle or refresh while the dialog is open shows up in it rather than the
  // snapshot taken when it opened.
  const [metadataLayerId, setMetadataLayerId] = useState<string | null>(null);
  const metadataLayer = useLayer(metadataLayerId) ?? null;
  const [metadataCopied, setMetadataCopied] = useState(false);
  const openMetadata = useCallback((layer: GeoLibreLayer) => {
    setMetadataLayerId(layer.id);
    setMetadataCopied(false);
  }, []);
  const closeMetadata = useCallback(() => {
    setMetadataLayerId(null);
    setMetadataCopied(false);
  }, []);
  // The layer was removed while its dialog was open: the dialog already reads
  // as closed (no record), so drop the id too, or a later layer that reuses it
  // (an undo, a re-add under the same id) would pop the dialog back open.
  useEffect(() => {
    if (metadataLayerId !== null && !metadataLayer) closeMetadata();
  }, [metadataLayerId, metadataLayer, closeMetadata]);
  // GeoTIFF header facts (CRS, pixel size, storage) for the raster whose
  // metadata dialog is open. The store layer does not carry them, so they are
  // read from the file on open (#1420): "loading" while the header is being
  // fetched, "error" when it cannot be read.
  const [rasterInfoState, setRasterInfoState] = useState<RasterInfoState | null>(null);
  // Explicit metadata dialog size once the user drags the corner grip (null =
  // the default responsive size). Kept across open/close so a size chosen for
  // one layer still applies to the next. `metadataDialogRef` reads the live
  // element size at the start of a drag; `metadataResizeCleanupRef` tears down
  // the listeners on unmount.
  const metadataDialogRef = useRef<HTMLDivElement>(null);
  const [metadataDialogSize, setMetadataDialogSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const metadataResizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => metadataResizeCleanupRef.current?.(), []);

  // Resize the metadata dialog from its bottom-end grip. The dialog is centred
  // via a -50% transform, so each edge moves by half the size change; growing
  // by 2x the pointer delta keeps the grip under the cursor. In an RTL layout
  // the grip renders on the physical left, so the horizontal delta is inverted
  // (the same idiom as the Basemap Extract panel's grip).
  const startMetadataResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const el = metadataDialogRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const isRtl = document.documentElement.dir === "rtl";
    const startX = event.clientX;
    const startY = event.clientY;
    const startW = rect.width;
    const startH = rect.height;
    let next = { width: startW, height: startH };
    let frame: number | null = null;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = isRtl ? "nesw-resize" : "nwse-resize";
    document.body.style.userSelect = "none";

    const onMove = (e: PointerEvent) => {
      const deltaX = (e.clientX - startX) * (isRtl ? -1 : 1);
      next = {
        width: Math.max(320, Math.min(window.innerWidth - 16, startW + deltaX * 2)),
        height: Math.max(240, Math.min(window.innerHeight - 16, startH + (e.clientY - startY) * 2)),
      };
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        setMetadataDialogSize(next);
      });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (frame !== null) window.cancelAnimationFrame(frame);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      metadataResizeCleanupRef.current = null;
    };
    const onUp = () => {
      cleanup();
      setMetadataDialogSize(next);
    };
    metadataResizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  // The header read scoped to the layer whose metadata dialog is open. A state
  // left over from a previously inspected layer is ignored rather than shown
  // under the new layer's name.
  const metadataRasterInfo =
    rasterInfoState && rasterInfoState.layerId === metadataLayer?.id ? rasterInfoState : null;
  const metadataJson = metadataLayer
    ? JSON.stringify(
        layerMetadataPayload(
          metadataLayer,
          metadataRasterInfo?.status === "ready" ? metadataRasterInfo.info : null,
        ),
        null,
        2,
      )
    : "";
  const copyMetadata = useCallback(() => {
    if (!metadataJson) return;
    void navigator.clipboard
      ?.writeText(metadataJson)
      .then(() => setMetadataCopied(true))
      .catch(() => setMetadataCopied(false));
  }, [metadataJson]);

  // Read the GeoTIFF header behind an open raster metadata dialog so it can
  // report the native CRS and pixel size the store layer never captured
  // (#1420). Only the header is fetched, and the result is dropped when the
  // dialog closes or moves to another layer while the read is in flight.
  // Keyed on the id and URL rather than the record, which changes identity on
  // every edit of the layer: a restyle must not re-read the header, while a
  // refresh that points the layer at a new file must.
  const metadataRasterUrl = metadataLayer ? rasterInfoUrl(metadataLayer) : null;
  useEffect(() => {
    const url = metadataRasterUrl;
    if (!metadataLayerId || !url) {
      setRasterInfoState(null);
      return;
    }

    const layerId = metadataLayerId;
    let cancelled = false;
    setRasterInfoState({ layerId, status: "loading" });
    void readRasterInfo(url)
      .then((info) => {
        if (!cancelled) setRasterInfoState({ layerId, status: "ready", info });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.warn("[GeoLibre] Failed to read raster metadata", error);
        setRasterInfoState({ layerId, status: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [metadataLayerId, metadataRasterUrl]);

  return {
    metadataLayer,
    openMetadata,
    closeMetadata,
    metadataCopied,
    metadataDialogRef,
    metadataDialogSize,
    startMetadataResize,
    metadataRasterInfo,
    metadataJson,
    copyMetadata,
  };
}

interface LayerMetadataDialogProps {
  /** The dialog state from useLayerMetadataDialog. */
  metadata: ReturnType<typeof useLayerMetadataDialog>;
}

/** The resizable layer metadata dialog, showing the layer's metadata as JSON. */
export function LayerMetadataDialog({ metadata }: LayerMetadataDialogProps) {
  const { t } = useTranslation();
  const {
    metadataLayer,
    closeMetadata,
    metadataCopied,
    metadataDialogRef,
    metadataDialogSize,
    startMetadataResize,
    metadataRasterInfo,
    metadataJson,
    copyMetadata,
  } = metadata;
  return (
    <Dialog
      open={!!metadataLayer}
      onOpenChange={(open: boolean) => {
        if (!open) closeMetadata();
      }}
    >
      <DialogContent
        ref={metadataDialogRef}
        style={
          metadataDialogSize
            ? {
                width: metadataDialogSize.width,
                height: metadataDialogSize.height,
                // Only the width cap is lifted (to the viewport, not to
                // `none`): a size chosen on a wide window must not leave the
                // dialog clipped once the window narrows. The height keeps
                // DialogContent's own viewport cap.
                maxWidth: "calc(100vw - 1rem)",
              }
            : undefined
        }
        bodyClassName="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4 sm:p-6"
        resizeHandle={
          <div
            role="separator"
            aria-label={t("layers.resizeMetadataDialog")}
            title={t("layers.resizeMetadataDialog")}
            onPointerDown={startMetadataResize}
            className="absolute bottom-0 end-0 z-10 hidden h-5 w-5 cursor-nwse-resize touch-none select-none text-muted-foreground hover:text-foreground md:block rtl:cursor-nesw-resize"
          >
            <svg viewBox="0 0 16 16" className="h-full w-full rtl:scale-x-[-1]" aria-hidden="true">
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
          <DialogTitle>
            {t("layers.metadataDialogTitle", { name: metadataLayer?.name })}
          </DialogTitle>
          <DialogDescription>{t("layers.metadataDialogDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={copyMetadata}>
            <Copy className="h-4 w-4" />
            {metadataCopied ? t("attributeStats.copiedToClipboard") : t("attributeStats.copy")}
          </Button>
        </div>
        {metadataRasterInfo && metadataRasterInfo.status !== "ready" && (
          <p className="text-xs text-muted-foreground">
            {metadataRasterInfo.status === "loading"
              ? t("layers.metadataRasterLoading")
              : t("layers.metadataRasterError")}
          </p>
        )}
        {/* A definite initial height lets Radix measure overflow on first
            layout; max-height alone left its viewport unconstrained until
            the resize handle caused a second measurement. */}
        <ScrollArea
          type="auto"
          className={cn("min-h-0", metadataDialogSize ? "flex-1" : "h-80 shrink-0")}
        >
          <pre className="whitespace-pre-wrap break-all text-xs">{metadataJson}</pre>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
