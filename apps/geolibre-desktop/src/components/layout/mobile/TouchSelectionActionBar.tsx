import { useAppStore } from "@geolibre/core";
import {
  cancelActiveFeatureSelection,
  finishFeatureSelection,
  getFeatureSelectionUiState,
  subscribeFeatureSelectionUiState,
  undoFeatureSelectionVertex,
} from "@geolibre/map";
import { Check, Undo2, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

function readFullscreenElement(): Element | null {
  if (typeof document === "undefined") return null;
  return (
    document.fullscreenElement ??
    (document as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement ??
    document.querySelector(".maplibregl-pseudo-fullscreen") ??
    null
  );
}

/**
 * Floating touch action bar displayed over the map while a feature-selection
 * gesture is active in Touch UI mode (GeoLibre#3537 Phase 3), replacing the
 * desktop double-click (Finish) and Escape (Cancel) shortcuts. Portals into
 * native fullscreen (`document.fullscreenElement`) or MapLibre's CSS fallback
 * (`.maplibregl-pseudo-fullscreen`, used on iOS Safari) so controls stay
 * reachable while fullscreen.
 */
export function TouchSelectionActionBar() {
  const { t } = useTranslation();
  const active = useAppStore((s) => s.featureSelectionActive);
  const { shape, vertexCount } = useSyncExternalStore(
    subscribeFeatureSelectionUiState,
    getFeatureSelectionUiState,
    getFeatureSelectionUiState,
  );
  const [fullscreenEl, setFullscreenEl] = useState<Element | null>(readFullscreenElement);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const sync = () => setFullscreenEl(readFullscreenElement());
    sync();
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    const observer = typeof MutationObserver !== "undefined" ? new MutationObserver(sync) : null;
    if (observer) {
      for (const el of document.querySelectorAll(".maplibregl-map")) {
        observer.observe(el, { attributes: true, attributeFilter: ["class"] });
      }
    }
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
      observer?.disconnect();
    };
  }, [active]);

  if (!active) return null;

  const isPolygon = shape === "polygon";

  const bar = (
    <div
      data-testid="touch-selection-action-bar"
      role="toolbar"
      aria-label={t("mobileShell.selectionBar.label")}
      className="pointer-events-auto absolute top-2.5 start-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border map-glass px-2 py-1 shadow-lg rtl:translate-x-1/2"
    >
      {isPolygon ? (
        <>
          <button
            type="button"
            disabled={vertexCount === 0}
            onClick={undoFeatureSelectionVertex}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent active:bg-accent disabled:pointer-events-none disabled:opacity-40"
          >
            <Undo2 className="h-4 w-4" aria-hidden="true" />
            <span>{t("mobileShell.selectionBar.undo")}</span>
          </button>
          <button
            type="button"
            disabled={vertexCount < 3}
            onClick={finishFeatureSelection}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-primary px-3.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 active:bg-primary/80 disabled:pointer-events-none disabled:opacity-40"
          >
            <Check className="h-4 w-4" aria-hidden="true" />
            <span>{t("mobileShell.selectionBar.finish")}</span>
          </button>
        </>
      ) : null}
      <button
        type="button"
        onClick={cancelActiveFeatureSelection}
        aria-label={t("common.cancel")}
        className={
          isPolygon
            ? "inline-flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
            : "inline-flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium text-foreground transition-colors hover:bg-accent active:bg-accent"
        }
      >
        <X className="h-4 w-4" aria-hidden="true" />
        {isPolygon ? null : <span>{t("common.cancel")}</span>}
      </button>
    </div>
  );

  return fullscreenEl ? createPortal(bar, fullscreenEl) : bar;
}
