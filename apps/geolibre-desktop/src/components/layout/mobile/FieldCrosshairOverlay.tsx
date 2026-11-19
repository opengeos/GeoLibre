import { useAppStore } from "@geolibre/core";
import { Check, Crosshair, Navigation, Plus, X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { appendFieldCaptureFeature, useFieldCrosshairStore } from "../../../lib/field-crosshair";
import { triggerHaptic } from "../../../lib/haptics";
import { registerMobileBackHandler } from "../../../lib/mobile-back-stack";
import { notify } from "../../../lib/notify";
import { useScreenWakeLock } from "../../../lib/wake-lock";

/**
 * Fixed center-of-map crosshair digitizing overlay for outdoor touch field
 * collection (GeoLibre#3537 Phase 4). Users pan the map underneath the reticle
 * and tap a thumb-zone button to drop a point at the exact map center or live
 * GPS fix.
 */
export function FieldCrosshairOverlay() {
  const { t } = useTranslation();
  const active = useFieldCrosshairStore((s) => s.active);
  const stop = useFieldCrosshairStore((s) => s.stop);
  const incrementCaptured = useFieldCrosshairStore((s) => s.incrementCaptured);
  const mapView = useAppStore((s) => s.mapView);
  const gpsStatus = useAppStore((s) => s.gpsStatus);
  useScreenWakeLock(active);

  useEffect(() => {
    if (!active) return;
    return registerMobileBackHandler(() => {
      stop();
      return true;
    });
  }, [active, stop]);

  if (!active) return null;

  const dropPoint = (source: "crosshair" | "gps") => {
    const lng = source === "gps" && gpsStatus ? gpsStatus.lng : mapView.center[0];
    const lat = source === "gps" && gpsStatus ? gpsStatus.lat : mapView.center[1];
    const store = useAppStore.getState();
    const existing = store.layers.find((layer) => layer.metadata.fieldCrosshair === true);
    const nextCollection = appendFieldCaptureFeature(existing?.geojson, {
      lng,
      lat,
      accuracyM: source === "gps" ? gpsStatus?.accuracy : null,
      source,
      capturedAt: new Date().toISOString(),
    });
    if (existing) {
      store.updateLayer(existing.id, { geojson: nextCollection });
    } else {
      const id = store.addGeoJsonLayer(t("mobileShell.crosshair.layerName"), nextCollection);
      store.updateLayer(id, { metadata: { fieldCrosshair: true } });
    }
    incrementCaptured();
    triggerHaptic("medium");
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
        <button
          type="button"
          onClick={stop}
          aria-label={t("common.close")}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground active:bg-accent"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
