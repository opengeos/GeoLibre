import { useAppStore } from "@geolibre/core";
import {
  cancelActiveFeatureSelection,
  finishFeatureSelection,
  undoFeatureSelectionVertex,
} from "@geolibre/map";
import { Check, Undo2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Floating touch action bar displayed over the map while a feature-selection
 * gesture is active in Touch UI mode (GeoLibre#3537 Phase 3), replacing the
 * desktop double-click (Finish) and Escape (Cancel) shortcuts.
 */
export function TouchSelectionActionBar() {
  const { t } = useTranslation();
  const active = useAppStore((s) => s.featureSelectionActive);

  if (!active) return null;

  return (
    <div
      data-testid="touch-selection-action-bar"
      role="toolbar"
      aria-label={t("mobileShell.selectionBar.label")}
      className="pointer-events-auto absolute top-2.5 start-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border map-glass px-2 py-1 shadow-lg rtl:translate-x-1/2"
    >
      <button
        type="button"
        onClick={undoFeatureSelectionVertex}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent active:bg-accent"
      >
        <Undo2 className="h-4 w-4" aria-hidden="true" />
        <span>{t("mobileShell.selectionBar.undo")}</span>
      </button>
      <button
        type="button"
        onClick={finishFeatureSelection}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-primary px-3.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 active:bg-primary/80"
      >
        <Check className="h-4 w-4" aria-hidden="true" />
        <span>{t("mobileShell.selectionBar.finish")}</span>
      </button>
      <button
        type="button"
        onClick={cancelActiveFeatureSelection}
        aria-label={t("common.cancel")}
        className="inline-flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
