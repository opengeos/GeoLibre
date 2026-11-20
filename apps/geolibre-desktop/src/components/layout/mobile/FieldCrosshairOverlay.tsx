import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { Check, Crosshair, Navigation, Plus } from "lucide-react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  appendFieldCaptureFeature,
  nextFieldCaptureIndex,
  useFieldCrosshairStore,
} from "../../../lib/field-crosshair";
import { notify } from "../../../lib/notify";

export interface FieldCrosshairOverlayProps {
  mapControllerRef: RefObject<MapEngine | null>;
}

/**
 * Fixed center-of-map crosshair digitizing overlay for outdoor touch field
 * collection (GeoLibre#3537 Phase 4). Users pan the map underneath the reticle
 * and tap a thumb-zone button to drop a point at the live map center or GPS fix.
 */
export function FieldCrosshairOverlay({ mapControllerRef }: FieldCrosshairOverlayProps) {
  const { t } = useTranslation();
  const active = useFieldCrosshairStore((s) => s.active);
  const capturedCount = useFieldCrosshairStore((s) => s.capturedCount);
  const stop = useFieldCrosshairStore((s) => s.stop);
  const incrementCaptured = useFieldCrosshairStore((s) => s.incrementCaptured);
  const gpsStatus = useAppStore((s) => s.gpsStatus);

  if (!active) return null;

  const dropPoint = (source: "crosshair" | "gps") => {
    // Read live camera center from the map controller so a tap during pan
    // inertia captures the exact point under the reticle rather than stale
    // moveend store state.
    const engine = mapControllerRef.current;
    const store = useAppStore.getState();
    const liveCenter = engine?.getRenderSurface() ? engine.readView().center : store.mapView.center;
    // Re-read live GPS status at tap time so a fix lost just before tapping
    // falls back to the reticle center without mislabeling the capture as "gps".
    const liveGps = source === "gps" ? store.gpsStatus : null;
    const effectiveSource: "crosshair" | "gps" = liveGps ? "gps" : "crosshair";
    const lng = liveGps ? liveGps.lng : liveCenter[0];
    const lat = liveGps ? liveGps.lat : liveCenter[1];
    const existing = store.layers.find((layer) => layer.metadata?.fieldCrosshair === true);
    const persistedNext =
      typeof existing?.metadata?.fieldCrosshairNextIndex === "number"
        ? existing.metadata.fieldCrosshairNextIndex
        : undefined;
    const usedIndex = nextFieldCaptureIndex(existing?.geojson?.features ?? [], persistedNext);
    const nextCollection = appendFieldCaptureFeature(
      existing?.geojson,
      {
        lng,
        lat,
        accuracyM: liveGps ? liveGps.accuracy : null,
        source: effectiveSource,
        capturedAt: new Date().toISOString(),
      },
      usedIndex,
    );
    if (existing) {
      store.updateLayer(existing.id, {
        geojson: nextCollection,
        metadata: {
          ...existing.metadata,
          fieldCrosshair: true,
          fieldCrosshairNextIndex: usedIndex + 1,
        },
      });
    } else {
      store.addGeoJsonLayer(t("mobileShell.crosshair.layerName"), nextCollection, undefined, null, {
        metadata: { fieldCrosshair: true, fieldCrosshairNextIndex: usedIndex + 1 },
      });
    }
    incrementCaptured();
    notify.info(
      t("mobileShell.crosshair.pointCaptured", {
        coords: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      }),
    );
  };

  return (
    <>
      <div
        aria-hidden="true"
        data-testid="field-crosshair-reticle"
        className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
      >
        <div className="relative flex h-12 w-12 items-center justify-center">
          <span className="absolute h-10 w-10 rounded-full border-2 border-primary bg-primary/10 shadow-sm" />
          <Crosshair className="h-6 w-6 text-primary drop-shadow" />
        </div>
      </div>
      <div
        data-testid="field-crosshair-bar"
        className="pointer-events-auto absolute bottom-3 start-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border map-glass px-2.5 py-1.5 shadow-xl rtl:translate-x-1/2"
      >
        <button
          type="button"
          data-testid="field-crosshair-drop"
          onClick={() => dropPoint("crosshair")}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-primary px-4 text-xs font-semibold text-primary-foreground shadow-xs active:bg-primary/85"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>{t("mobileShell.crosshair.dropPoint")}</span>
          {capturedCount > 0 ? (
            <span className="rounded-full bg-primary-foreground/20 px-1.5 py-0.5 font-mono text-[10px] leading-none">
              {capturedCount}
            </span>
          ) : null}
        </button>
        {gpsStatus ? (
          <button
            type="button"
            onClick={() => dropPoint("gps")}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full border bg-background/90 px-3 text-xs font-medium text-foreground active:bg-accent"
          >
            <Navigation className="h-4 w-4 text-emerald-500" aria-hidden="true" />
            <span>{t("mobileShell.crosshair.useGps")}</span>
          </button>
        ) : null}
        <button
          type="button"
          data-testid="field-crosshair-done"
          onClick={stop}
          aria-label={t("mobileShell.crosshair.done")}
          className="inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground active:bg-accent"
        >
          <Check className="h-4 w-4" aria-hidden="true" />
          <span>{t("mobileShell.crosshair.done")}</span>
        </button>
      </div>
    </>
  );
}
