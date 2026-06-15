import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type maplibregl from "maplibre-gl";
import type { MapController } from "@geolibre/map";
import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  ScrollArea,
  Slider,
} from "@geolibre/ui";
import { Crosshair, ImagePlus, MapPin, Trash2 } from "lucide-react";
import {
  cornersToBounds,
  type GCP,
  gcpResidualsMeters,
  imageCornersToMap,
  type LngLat,
  MIN_GCPS,
  solveAffine,
} from "../../lib/georeference";
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

/** Reject pathologically large images so the project JSON stays manageable. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function createId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** A GCP plus a stable React key, so deleting one doesn't shuffle the rest. */
type KeyedGCP = GCP & { key: number };

/** True when every corner is a valid [lng, lat] within world bounds. */
function cornersInRange(corners: LngLat[]): boolean {
  return corners.every(
    ([lng, lat]) =>
      Number.isFinite(lng) &&
      Number.isFinite(lat) &&
      lng >= -180 &&
      lng <= 180 &&
      lat >= -90 &&
      lat <= 90,
  );
}

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
  const [pendingPixel, setPendingPixel] = useState<{ px: number; py: number } | null>(
    null,
  );
  const [linking, setLinking] = useState(false);
  const [opacity, setOpacity] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const linkPixelRef = useRef<{ px: number; py: number } | null>(null);
  // Skip the open-reset when we reopen after a map link, to keep captured state.
  const suppressResetRef = useRef(false);
  // Monotonic id for stable GCP React keys.
  const gcpKeyRef = useRef(0);

  const getMap = useCallback(
    () => mapControllerRef.current?.getMap() ?? null,
    [mapControllerRef],
  );

  const affine = useMemo(() => solveAffine(gcps), [gcps]);
  const residuals = useMemo(
    () => (affine ? gcpResidualsMeters(affine, gcps) : null),
    [affine, gcps],
  );

  useEffect(() => {
    if (!open) return;
    if (suppressResetRef.current) {
      suppressResetRef.current = false;
      return;
    }
    setImage(null);
    setGcps([]);
    setPendingPixel(null);
    setLinking(false);
    setOpacity(1);
    setNotice(null);
  }, [open]);

  const handleImageFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      if (file.size > MAX_IMAGE_BYTES) {
        setNotice(
          t("georeferencer.imageTooLarge", {
            max: `${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB`,
          }),
        );
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => setNotice(t("georeferencer.imageReadError"));
      reader.onload = () => {
        const url = typeof reader.result === "string" ? reader.result : "";
        if (!url) {
          setNotice(t("georeferencer.imageReadError"));
          return;
        }
        const probe = new Image();
        probe.onload = () => {
          setImage({
            url,
            width: probe.naturalWidth,
            height: probe.naturalHeight,
            name: file.name.replace(/\.[^.]+$/, ""),
          });
          setGcps([]);
          setPendingPixel(null);
          setNotice(null);
        };
        probe.onerror = () => setNotice(t("georeferencer.imageReadError"));
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
        setGcps((gs) => [
          ...gs,
          { px: p.px, py: p.py, lng: e.lngLat.lng, lat: e.lngLat.lat, key },
        ]);
        setPendingPixel(null);
      }
      setLinking(false);
      suppressResetRef.current = true;
      onOpenChange(true);
    };
    // Escape aborts the link and restores the dialog (keeps the pending pixel).
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      setLinking(false);
      suppressResetRef.current = true;
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
      setNotice(t("georeferencer.cornersOutOfRange"));
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

  const removeGcp = (index: number) =>
    setGcps((gs) => gs.filter((_, i) => i !== index));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("georeferencer.title")}</DialogTitle>
          <DialogDescription>{t("georeferencer.description")}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[64vh] pr-3">
          <div className="space-y-4 py-1">
            {!image ? (
              <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed p-6 text-sm text-muted-foreground hover:bg-accent">
                <ImagePlus className="h-6 w-6" />
                {t("georeferencer.loadImage")}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleImageFile}
                />
              </label>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label>
                    {t("georeferencer.sourceImage", {
                      w: image.width,
                      h: image.height,
                    })}
                  </Label>
                  <div className="relative inline-block max-w-full overflow-hidden rounded-md border">
                    <img
                      ref={imgRef}
                      src={image.url}
                      alt={image.name}
                      onClick={handleImageClick}
                      className="block max-h-64 max-w-full cursor-crosshair select-none"
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
                    className="ml-auto"
                    disabled={!pendingPixel}
                    onClick={handleLinkOnMap}
                  >
                    <Crosshair className="mr-1 h-3.5 w-3.5" />
                    {t("georeferencer.linkOnMap")}
                  </Button>
                </div>

                {/* GCP table */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label>
                      {t("georeferencer.gcps", { count: gcps.length })}
                    </Label>
                    {residuals && (
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {t("georeferencer.rms", {
                          rms: residuals.rms.toFixed(1),
                        })}
                      </span>
                    )}
                  </div>
                  {gcps.length < MIN_GCPS ? (
                    <p className="text-sm text-muted-foreground">
                      {t("georeferencer.needGcps", { min: MIN_GCPS })}
                    </p>
                  ) : !affine ? (
                    <p className="text-sm text-destructive">
                      {t("georeferencer.collinear")}
                    </p>
                  ) : null}
                  {gcps.length > 0 && (
                    <div className="overflow-hidden rounded-md border text-sm">
                      <table className="w-full">
                        <thead className="bg-muted/50 text-xs text-muted-foreground">
                          <tr>
                            <th className="px-2 py-1 text-left">#</th>
                            <th className="px-2 py-1 text-right">px, py</th>
                            <th className="px-2 py-1 text-right">lng, lat</th>
                            <th className="px-2 py-1 text-right">
                              {t("georeferencer.residual")}
                            </th>
                            <th className="px-2 py-1" />
                          </tr>
                        </thead>
                        <tbody>
                          {gcps.map((g, i) => (
                            <tr key={g.key} className="border-t">
                              <td className="px-2 py-1">{i + 1}</td>
                              <td className="px-2 py-1 text-right tabular-nums">
                                {g.px}, {g.py}
                              </td>
                              <td className="px-2 py-1 text-right tabular-nums">
                                {g.lng.toFixed(4)}, {g.lat.toFixed(4)}
                              </td>
                              <td className="px-2 py-1 text-right tabular-nums">
                                {residuals
                                  ? `${residuals.perPoint[i].toFixed(1)} m`
                                  : "—"}
                              </td>
                              <td className="px-2 py-1 text-right">
                                <button
                                  type="button"
                                  aria-label={t("common.remove")}
                                  onClick={() => removeGcp(i)}
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
              </>
            )}

            {notice && (
              <p
                aria-live="polite"
                className="rounded-md bg-muted p-2 text-sm text-muted-foreground"
              >
                {notice}
              </p>
            )}
          </div>
        </ScrollArea>

        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
          <Button onClick={handleApply} disabled={!affine || !image}>
            <MapPin className="mr-2 h-4 w-4" />
            {t("georeferencer.addToMap")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
