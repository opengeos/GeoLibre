import { useTranslation } from "react-i18next";
import { isPopupHoverEnabled, useAppStore } from "@geolibre/core";

/**
 * Session-only switch that pauses every layer's hover tooltip without
 * touching the saved popup settings. Shared by the editor and viewer panels.
 */
export function LayerHoverControls({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const enabled = useAppStore((s) => s.hoverTooltipsEnabled);
  const setEnabled = useAppStore((s) => s.setHoverTooltipsEnabled);
  // Hover tips are off by default, so most projects never need this row.
  // Keep it while tips are paused so they can be switched back on.
  const relevant = useAppStore(
    (s) => !s.hoverTooltipsEnabled || s.layers.some((layer) => isPopupHoverEnabled(layer.popup)),
  );
  if (!relevant) return null;

  return (
    <label className={`flex cursor-pointer items-center gap-2 text-xs ${className}`}>
      <input
        type="checkbox"
        data-testid="hover-tooltips-toggle"
        checked={enabled}
        onChange={(event) => setEnabled(event.target.checked)}
      />
      <span className="text-muted-foreground">{t("layers.hoverTooltips")}</span>
    </label>
  );
}
