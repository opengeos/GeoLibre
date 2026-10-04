import { Button } from "@geolibre/ui";
import { Eye, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  CVD_MODES,
  cvdColorMatrixValues,
  cvdFilterId,
  type CvdMode,
} from "../../lib/cvd-simulation";
import { CVD_MODE_LABEL_KEYS, useCvdPreviewStore } from "../../lib/cvd-preview-store";

/**
 * Hidden SVG holding one `feColorMatrix` filter per CVD mode. Always mounted
 * (it is tiny) so the CSS `filter: url(#…)` reference resolves the moment a
 * mode is picked.
 */
function CvdFilterDefs() {
  return (
    <svg aria-hidden="true" focusable="false" width="0" height="0" className="absolute h-0 w-0">
      <defs>
        {CVD_MODES.map((mode) => (
          <filter
            key={mode}
            id={cvdFilterId(mode)}
            // The matrices are defined on linear RGB (see cvd-simulation.ts).
            colorInterpolationFilters="linearRGB"
          >
            <feColorMatrix type="matrix" values={cvdColorMatrixValues(mode)} />
          </filter>
        ))}
      </defs>
    </svg>
  );
}

/** The on-map notice shown while a preview is active, with a button to end it. */
function CvdPreviewBadge({ mode }: { mode: CvdMode }) {
  const { t } = useTranslation();
  const setMode = useCvdPreviewStore((s) => s.setMode);
  const label = t("cvdPreview.badge", { mode: t(CVD_MODE_LABEL_KEYS[mode]) });
  return (
    // Symmetric centering stays physical (left-1/2 + -translate-x-1/2), per
    // docs/i18n.md. Sits above the attribution/scale row.
    <div
      className="pointer-events-none absolute bottom-10 left-1/2 z-20 flex -translate-x-1/2 justify-center"
      data-testid="cvd-preview-badge"
    >
      <div
        role="status"
        className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-input map-glass py-0.5 pe-0.5 ps-2.5 text-xs font-medium text-foreground shadow-sm"
      >
        <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="whitespace-nowrap">{label}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 rounded-full p-0"
          onClick={() => setMode(null)}
          title={t("cvdPreview.turnOff")}
          aria-label={t("cvdPreview.turnOff")}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Wraps the map area and, while a color-vision-deficiency preview is active,
 * filters every `<canvas>` inside it (all panes, every renderer — MapLibre,
 * Mapbox, Cesium, ArcGIS — and deck.gl overlays), DOM map markers, and on-map
 * legends (`data-cvd-filter`), through
 * the matching SVG filter. The filter is scoped by `index.css` to those
 * elements so UI chrome (controls, panels, dialogs) keeps its real colors.
 *
 * The wrapper is `display: contents`, so it adds no box and leaves the map
 * layout untouched; the data attribute is only a selector hook.
 *
 * Exports are unaffected: Print Layout, Export Map Image, and Record Video read
 * the canvases' pixel buffers (drawImage / toBlob / captureStream), which a CSS
 * filter never touches, and Record Video's DOM overlay pass only rasterizes the
 * HTML/legend/colorbar panels, not this badge. Only an OS-level screenshot of
 * the window shows the simulation, which is what the badge is for.
 */
export function CvdPreview({ children }: { children: ReactNode }) {
  const mode = useCvdPreviewStore((s) => s.mode);
  return (
    <div className="contents" data-cvd-preview={mode ?? undefined}>
      <CvdFilterDefs />
      {children}
      {mode ? <CvdPreviewBadge mode={mode} /> : null}
    </div>
  );
}
