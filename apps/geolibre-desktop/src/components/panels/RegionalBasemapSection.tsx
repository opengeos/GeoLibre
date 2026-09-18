import { REGIONAL_BASEMAP_GROUPS, type RegionalBasemap } from "@geolibre/core";
import { cn } from "@geolibre/ui";
import { useTranslation } from "react-i18next";
import { regionalBasemapRegionKey } from "../../lib/regional-sections";
import { CollapsibleSection } from "../CollapsibleSection";

interface RegionalBasemapSectionProps {
  /** Id of the currently selected basemap, so one button highlights. */
  selectedId?: string;
  onSelect: (basemap: RegionalBasemap) => void;
}

/**
 * The Regional basemaps section shared by the New Project and Change Basemap
 * panels, so the two cannot drift.
 *
 * These are basemaps for places the default catalog does not serve well —
 * today, providers reachable from inside mainland China, where OpenFreeMap and
 * Protomaps are slow or unreachable. One collapsed section holds every region,
 * each under its own heading, so a future region is an entry in
 * {@link REGIONAL_BASEMAP_GROUPS} rather than another top-level section.
 *
 * Collapsed by default, since most users never need a regional basemap, but
 * auto-expanded when one of them is the current selection so an active choice
 * is never hidden behind a closed heading.
 */
export function RegionalBasemapSection({ selectedId, onSelect }: RegionalBasemapSectionProps) {
  const { t } = useTranslation();
  const selectionIsRegional = REGIONAL_BASEMAP_GROUPS.some((group) =>
    group.basemaps.some((basemap) => basemap.id === selectedId),
  );

  return (
    <CollapsibleSection
      title={t("basemapPicker.sectionRegional")}
      defaultOpen={selectionIsRegional}
    >
      <div className="space-y-4">
        {REGIONAL_BASEMAP_GROUPS.map((group) => (
          <div key={group.id} className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              {t(regionalBasemapRegionKey(group.id))}
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {group.basemaps.map((basemap) => (
                <button
                  key={basemap.id}
                  type="button"
                  aria-pressed={basemap.id === selectedId}
                  className={cn(
                    "flex min-h-10 items-center justify-center rounded-md border px-3 py-1.5 text-center text-sm font-medium leading-tight transition-colors",
                    "hover:bg-accent hover:text-accent-foreground",
                    basemap.id === selectedId
                      ? "border-primary bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                      : "border-input bg-background",
                  )}
                  onClick={() => onSelect(basemap)}
                >
                  {basemap.name}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}
