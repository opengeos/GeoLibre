import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type maplibregl from "maplibre-gl";
import type { MapController } from "@geolibre/map";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  ScrollArea,
  Select,
  Slider,
} from "@geolibre/ui";
import {
  Crosshair,
  Download,
  FileDown,
  ImagePlus,
  Loader2,
  MapPin,
  Maximize2,
  Trash2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  cornersInRange,
  cornersToBounds,
  type GCP,
  gcpResidualsMeters,
  gcpsToCsv,
  type GeoTransform,
  imageCornersToMap,
  MIN_GCPS,
  minGcpsForTransform,
  parseGcpsCsv,
  solveAffine,
} from "../../lib/georeference";
import { exportGeoTiff } from "../../lib/georeference-gdal";
import { releaseBodyPointerEvents } from "../../lib/radix-compat";

interface GeoreferencerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}

interface LoadedImage {
  url: string; // data URL (persists in the project)
  width: number;
  height: number;
  name: string;
}

/**
 * Cap the source image size. It's stored inline as a base64 data URL (~4/3 the
 * file size) in the project and in every collaboration snapshot, so keep it
 * modest. A true GeoTIFF/COG export path (rasterio sidecar) would avoid the
 * inline payload for large scans.
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.5;

/** Trigger a browser download of text or binary content. */
function download(filename: string, data: BlobPart, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so the browser can fetch the blob first (Firefox races and
  // silently drops the download if the URL is revoked synchronously).
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function createId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** A GCP plus a stable React key, so deleting one doesn't shuffle the rest. */
type KeyedGCP = GCP & { key: number };

/**
 * Raster Georeferencer: load a non-georeferenced image, place ground control
 * points (GCPs) linking image pixels to map coordinates, then add the image to
 * the map as a corner-pinned overlay using a least-squares affine fit. Shows the
 * RMS residual so the user can judge fit quality. Polynomial/TPS warps and true
 * GeoTIFF/COG export are a rasterio-sidecar follow-up.
 */
export function GeoreferencerDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: GeoreferencerDialogProps) {
  const { t } = useTranslation();
  const addLayer = useAppStore((s) => s.addLayer);

  const [image, setImage] = useState<LoadedImage | null>(null);
  const [gcps, setGcps] = useState<KeyedGCP[]>([]);
  const [pendingPixel, setPendingPixel] = useState<{ px: number; py: number } | null>(null);
  const [linking, setLinking] = useState(false);
  const [opacity, setOpacity] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [transform, setTransform] = useState<GeoTransform>("affine");
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{
    msg: string;
    kind: "error" | "info";
  } | null>(null);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const linkPixelRef = useRef<{ px: number; py: number } | null>(null);
  // Monotonic id for stable GCP React keys.
  const gcpKeyRef = useRef(0);

  const getMap = useCallback(() => mapControllerRef.current?.getMap() ?? null, [mapControllerRef]);

  const affine = useMemo(() => solveAffine(gcps), [gcps]);
  const residuals = useMemo(
    () => (affine ? gcpResidualsMeters(affine, gcps) : null),
    [affine, gcps],
  );

  // The dialog keeps its image + GCPs across close/reopen (and after "Add to
  // map") so the session persists; only an explicit Clear resets it.
  const handleClear = useCallback(() => {
    setImage(null);
    setGcps([]);
    setPendingPixel(null);
    setLinking(false);
    setOpacity(1);
    setZoom(1);
    setTransform("affine");
    setExporting(false);
    setNotice(null);
  }, []);

  const handleImageFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      if (file.size > MAX_IMAGE_BYTES) {
        setNotice({
          msg: t("georeferencer.imageTooLarge", {
            max: `${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB`,
          }),
          kind: "error",
        });
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => setNotice({ msg: t("georeferencer.imageReadError"), kind: "error" });
      reader.onload = () => {
        const url = typeof reader.result === "string" ? reader.result : "";
        if (!url) {
          setNotice({ msg: t("georeferencer.imageReadError"), kind: "error" });
          return;
        }
        const probe = new Image();
        probe.onload = () => {
          // Reject images with no intrinsic pixel size (e.g. an SVG without a
          // width/height) — the GCP pixel math needs real raster dimensions.
          if (probe.naturalWidth === 0 || probe.naturalHeight === 0) {
            setNotice({ msg: t("georeferencer.imageNoDimensions"), kind: "error" });
            return;
          }
          setImage({
            url,
            width: probe.naturalWidth,
            height: probe.naturalHeight,
            name: file.name.replace(/\.[^.]+$/, ""),
          });
          setGcps([]);
          setPendingPixel(null);
          setZoom(1);
          setNotice(null);
        };
        probe.onerror = () => setNotice({ msg: t("georeferencer.imageReadError"), kind: "error" });
        probe.src = url;
      };
      reader.readAsDataURL(file);
    },
    [t],
  );

  // Click the image preview to set the pending source pixel (natural coords).
  const handleImageClick = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      const el = imgRef.current;
      if (!el || !image) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const px = Math.round(((e.clientX - rect.left) / rect.width) * image.width);
      const py = Math.round(((e.clientY - rect.top) / rect.height) * image.height);
      setPendingPixel({
        px: Math.max(0, Math.min(image.width - 1, px)),
        py: Math.max(0, Math.min(image.height - 1, py)),
      });
      setNotice(null);
    },
    [image],
  );

  const handleLinkOnMap = useCallback(() => {
    if (!pendingPixel || !getMap()) return;
    linkPixelRef.current = pendingPixel;
    setLinking(true);
    onOpenChange(false);
  }, [pendingPixel, getMap, onOpenChange]);

  useEffect(() => {
    if (!linking) return;
    const map = getMap();
    if (!map) {
      setLinking(false);
      return;
    }
    releaseBodyPointerEvents();
    const raf = requestAnimationFrame(releaseBodyPointerEvents);
    const prevCursor = map.getCanvas().style.cursor;
    map.getCanvas().style.cursor = "crosshair";
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const p = linkPixelRef.current;
      if (p) {
        const key = (gcpKeyRef.current += 1);
        setGcps((gs) => [...gs, { px: p.px, py: p.py, lng: e.lngLat.lng, lat: e.lngLat.lat, key }]);
        setPendingPixel(null);
      }
      setLinking(false);
      onOpenChange(true);
    };
    // Escape aborts the link and restores the dialog (keeps the pending pixel).
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      // Remove the click handler synchronously so a queued click can't still
      // fire onClick (and add a stray GCP) before the effect cleanup runs.
      map.off("click", onClick);
      setLinking(false);
      onOpenChange(true);
    };
    map.once("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      map.off("click", onClick);
      window.removeEventListener("keydown", onKey);
      map.getCanvas().style.cursor = prevCursor;
    };
  }, [linking, getMap, onOpenChange]);

  const handleApply = useCallback(() => {
    if (!affine || !image) return;
    const c = imageCornersToMap(affine, image.width, image.height);
    const coordinates = [c.tl, c.tr, c.br, c.bl];
    // A poor fit can project corners outside world bounds, which the map's image
    // source would silently reject — warn instead of adding an invisible layer.
    if (!cornersInRange(coordinates)) {
      setNotice({ msg: t("georeferencer.cornersOutOfRange"), kind: "error" });
      return;
    }
    const bounds = cornersToBounds(coordinates);
    const layer: GeoLibreLayer = {
      id: createId(),
      name: image.name || t("georeferencer.defaultName"),
      type: "image",
      source: { type: "image", url: image.url, coordinates },
      visible: true,
      opacity,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {
        sourceKind: "georeferenced-image",
        bounds,
        // Persist plain GCPs (drop the transient React key) for reproducibility.
        gcps: gcps.map(({ px, py, lng, lat }) => ({ px, py, lng, lat })),
      },
    };
    addLayer(layer);
    mapControllerRef.current?.fitBounds(bounds);
    onOpenChange(false);
  }, [affine, image, opacity, gcps, addLayer, mapControllerRef, onOpenChange, t]);

  const removeGcp = (key: number) => setGcps((gs) => gs.filter((g) => g.key !== key));

  const handleExportGeoTiff = useCallback(async () => {
    if (!affine || !image || exporting) return;
    setExporting(true);
    setNotice({ msg: t("georeferencer.exporting"), kind: "info" });
    try {
      const bytes = await exportGeoTiff(image.url, image.name || "georeferenced", gcps, transform);
      download(`${image.name || "georeferenced"}.tif`, bytes as BlobPart, "image/tiff");
      setNotice({ msg: t("georeferencer.exported"), kind: "info" });
    } catch (err) {
      console.error("GeoTIFF export failed", err);
      setNotice({ msg: t("georeferencer.exportFailed"), kind: "error" });
    } finally {
      setExporting(false);
    }
  }, [affine, image, exporting, gcps, transform, t]);

  const handleExportGcps = useCallback(() => {
    if (gcps.length === 0) return;
    const base = image?.name || "georeference";
    download(`${base}-gcps.csv`, gcpsToCsv(gcps), "text/csv");
  }, [gcps, image]);

  const handleImportGcps = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      const reader = new FileReader();
      reader.onerror = () => setNotice({ msg: t("georeferencer.gcpsReadError"), kind: "error" });
      reader.onload = () => {
        const text = typeof reader.result === "string" ? reader.result : "";
        const parsed = parseGcpsCsv(text);
        if (parsed.length === 0) {
          setNotice({ msg: t("georeferencer.gcpsReadError"), kind: "error" });
          return;
        }
        setGcps(parsed.map((g) => ({ ...g, key: (gcpKeyRef.current += 1) })));
        setPendingPixel(null);
        // Warn if any point falls outside the loaded image (e.g. a CSV made for
        // a different-resolution version) — the markers would sit off-image.
        const outside =
          image != null && parsed.some((g) => g.px > image.width || g.py > image.height);
        setNotice(
          outside
            ? { msg: t("georeferencer.gcpsOutsideImage"), kind: "error" }
            : {
                msg: t("georeferencer.gcpsImported", { count: parsed.length }),
                kind: "info",
              },
        );
      };
      reader.readAsText(file);
    },
    [t, image],
  );

  const zoomIn = () => setZoom((z) => Math.min(MAX_ZOOM, +(z * ZOOM_STEP).toFixed(2)));
  const zoomOut = () => setZoom((z) => Math.max(MIN_ZOOM, +(z / ZOOM_STEP).toFixed(2)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[48rem] min-w-[22rem] max-w-[95vw] resize">
        <DialogHeader>
          <DialogTitle>{t("georeferencer.title")}</DialogTitle>
          <DialogDescription>{t("georeferencer.description")}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[64vh] pe-3">
          <div className="space-y-4 py-1">
            {!image ? (
              <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed p-6 text-sm text-muted-foreground hover:bg-accent">
                <ImagePlus className="h-6 w-6" />
                {t("georeferencer.loadImage")}
                <input type="file" accept="image/*" className="hidden" onChange={handleImageFile} />
              </label>
            ) : (
              <>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label>
                      {t("georeferencer.sourceImage", {
                        w: image.width,
                        h: image.height,
                      })}
                    </Label>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("georeferencer.zoomOut")}
                        disabled={zoom <= MIN_ZOOM}
                        onClick={zoomOut}
                      >
                        <ZoomOut className="h-4 w-4" />
                      </Button>
                      <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">
                        {Math.round(zoom * 100)}%
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("georeferencer.zoomIn")}
                        disabled={zoom >= MAX_ZOOM}
                        onClick={zoomIn}
                      >
                        <ZoomIn className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("georeferencer.zoomReset")}
                        disabled={zoom === MIN_ZOOM}
                        onClick={() => setZoom(1)}
                      >
                        <Maximize2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  {/* Scroll viewport; the inner wrapper scales with zoom so GCP
                      markers (positioned by %) and click→pixel math stay aligned. */}
                  <div className="relative max-h-[60vh] min-h-[12rem] resize-y overflow-auto rounded-md border">
                    <div className="relative" style={{ width: `${zoom * 100}%` }}>
                      <img
                        ref={imgRef}
                        src={image.url}
                        alt={image.name}
                        onClick={handleImageClick}
                        className="block w-full cursor-crosshair select-none"
                        draggable={false}
                      />
                      {gcps.map((g, i) => (
                        <span
                          key={g.key}
                          className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-primary text-[8px] leading-3 text-white"
                          style={{
                            left: `${(g.px / image.width) * 100}%`,
                            top: `${(g.py / image.height) * 100}%`,
                          }}
                        >
                          {i + 1}
                        </span>
                      ))}
                      {pendingPixel && (
                        <span
                          className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-full border border-white bg-amber-500"
                          style={{
                            left: `${(pendingPixel.px / image.width) * 100}%`,
                            top: `${(pendingPixel.py / image.height) * 100}%`,
                          }}
                        />
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">
                    {pendingPixel
                      ? t("georeferencer.pixelPicked", {
                          x: pendingPixel.px,
                          y: pendingPixel.py,
                        })
                      : t("georeferencer.clickImageHint")}
                  </span>
                  <Button
                    size="sm"
                    className="ms-auto"
                    disabled={!pendingPixel}
                    onClick={handleLinkOnMap}
                  >
                    <Crosshair className="me-1 h-3.5 w-3.5" />
                    {t("georeferencer.linkOnMap")}
                  </Button>
                </div>

                {/* GCP table */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="shrink-0">
                      {t("georeferencer.gcps", { count: gcps.length })}
                    </Label>
                    <div className="flex items-center gap-2">
                      {residuals && (
                        <span className="text-sm tabular-nums text-muted-foreground">
                          {t("georeferencer.rms", {
                            rms: residuals.rms.toFixed(1),
                          })}
                        </span>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={gcps.length === 0}
                        onClick={handleExportGcps}
                      >
                        <Download className="me-1 h-3.5 w-3.5" />
                        {t("georeferencer.exportGcps")}
                      </Button>
                      <label className="inline-flex cursor-pointer items-center rounded-md px-2 py-1 text-sm hover:bg-accent">
                        <Upload className="me-1 h-3.5 w-3.5" />
                        {t("georeferencer.importGcps")}
                        <input
                          type="file"
                          accept=".csv,.txt,text/csv"
                          className="hidden"
                          onChange={handleImportGcps}
                        />
                      </label>
                    </div>
                  </div>
                  {gcps.length < MIN_GCPS ? (
                    <p className="text-sm text-muted-foreground">
                      {t("georeferencer.needGcps", { min: MIN_GCPS })}
                    </p>
                  ) : !affine ? (
                    <p className="text-sm text-destructive">{t("georeferencer.collinear")}</p>
                  ) : null}
                  {gcps.length > 0 && (
                    <div className="overflow-hidden rounded-md border text-sm">
                      <table className="w-full">
                        <thead className="bg-muted/50 text-xs text-muted-foreground">
                          <tr>
                            <th className="px-2 py-1 text-start">#</th>
                            <th className="px-2 py-1 text-end">px, py</th>
                            <th className="px-2 py-1 text-end">lng, lat</th>
                            <th className="px-2 py-1 text-end">{t("georeferencer.residual")}</th>
                            <th className="px-2 py-1" />
                          </tr>
                        </thead>
                        <tbody>
                          {gcps.map((g, i) => (
                            <tr key={g.key} className="border-t">
                              <td className="px-2 py-1">{i + 1}</td>
                              <td className="px-2 py-1 text-end tabular-nums">
                                {g.px}, {g.py}
                              </td>
                              <td className="px-2 py-1 text-end tabular-nums">
                                {g.lng.toFixed(4)}, {g.lat.toFixed(4)}
                              </td>
                              <td className="px-2 py-1 text-end tabular-nums">
                                {residuals ? `${residuals.perPoint[i].toFixed(1)} m` : "—"}
                              </td>
                              <td className="px-2 py-1 text-end">
                                <button
                                  type="button"
                                  aria-label={t("common.remove")}
                                  onClick={() => removeGcp(g.key)}
                                  className="text-muted-foreground hover:text-destructive"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label>{t("georeferencer.opacity")}</Label>
                    <span className="text-sm tabular-nums text-muted-foreground">
                      {Math.round(opacity * 100)}%
                    </span>
                  </div>
                  <Slider
                    min={0}
                    max={1}
                    step={0.05}
                    value={[opacity]}
                    onValueChange={(v: number[]) => setOpacity(v[0])}
                  />
                </div>

                {/* GeoTIFF export (client-side, via gdal3.js) */}
                <div className="space-y-1.5 rounded-md border p-2">
                  <Label htmlFor="georef-transform">{t("georeferencer.exportTiff")}</Label>
                  <div className="flex items-center gap-2">
                    <Select
                      id="georef-transform"
                      className="flex-1"
                      value={transform}
                      disabled={exporting}
                      onChange={(e) => setTransform(e.target.value as GeoTransform)}
                    >
                      <option value="affine">{t("georeferencer.transform.affine")}</option>
                      <option value="polynomial">{t("georeferencer.transform.polynomial")}</option>
                      <option value="tps">{t("georeferencer.transform.tps")}</option>
                    </Select>
                    <Button
                      variant="outline"
                      className="shrink-0"
                      disabled={
                        !affine || exporting || gcps.length < minGcpsForTransform(transform)
                      }
                      onClick={handleExportGeoTiff}
                    >
                      {exporting ? (
                        <Loader2 className="me-2 h-4 w-4 animate-spin" />
                      ) : (
                        <FileDown className="me-2 h-4 w-4" />
                      )}
                      {t("georeferencer.exportTiffButton")}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {affine && gcps.length < minGcpsForTransform(transform)
                      ? t("georeferencer.transformNeedsMore", {
                          min: minGcpsForTransform(transform),
                        })
                      : t("georeferencer.exportTiffHint")}
                  </p>
                </div>
              </>
            )}

            {notice && (
              <p
                aria-live="polite"
                className={cn(
                  "rounded-md p-2 text-sm",
                  notice.kind === "error"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {notice.msg}
              </p>
            )}
          </div>
        </ScrollArea>

        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            className="text-muted-foreground"
            disabled={!image && gcps.length === 0}
            onClick={handleClear}
          >
            <Trash2 className="me-2 h-4 w-4" />
            {t("georeferencer.clear")}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.close")}
            </Button>
            <Button onClick={handleApply} disabled={!affine || !image}>
              <MapPin className="me-2 h-4 w-4" />
              {t("georeferencer.addToMap")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
