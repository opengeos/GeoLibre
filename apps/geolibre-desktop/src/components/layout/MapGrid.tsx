import {
  BLANK_BASEMAP,
  OPENFREEMAP_BASEMAPS,
  useAppStore,
} from "@geolibre/core";
import { SecondaryMapCanvas } from "@geolibre/map";
import { Select } from "@geolibre/ui";
import { X } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";

interface MapGridProps {
  /** The primary map pane (MapCanvas plus its overlays), rendered in cell 0. */
  children: ReactNode;
}

/**
 * Lays out the workspace's map panes.
 *
 * With a single pane (the default) it renders the primary map untouched, so the
 * normal single-map DOM and behavior are unchanged. With a larger grid it tiles
 * the primary map plus one {@link SecondaryMapCanvas} per `secondaryMapViews`
 * entry into a CSS grid, each secondary pane carrying its own basemap picker and
 * a button to drop it. Camera sync between panes is handled inside the canvases
 * (via the shared global `mapView`); this component only owns layout and chrome.
 */
export function MapGrid({ children }: MapGridProps) {
  const rows = useAppStore((s) => s.mapLayout.rows);
  const cols = useAppStore((s) => s.mapLayout.cols);
  const secondaryMapViews = useAppStore((s) => s.secondaryMapViews);

  if (rows * cols <= 1) {
    return <>{children}</>;
  }

  return (
    <div
      className="grid h-full w-full gap-0.5 bg-border"
      style={{
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      }}
      data-testid="map-grid"
    >
      <div className="relative isolate min-h-0 min-w-0 overflow-hidden bg-background">
        {children}
      </div>
      {secondaryMapViews.map((pane, index) => (
        <SecondaryMapPane key={pane.id} viewId={pane.id} index={index} />
      ))}
    </div>
  );
}

interface SecondaryMapPaneProps {
  viewId: string;
  /** Zero-based index among secondary panes, shown in the pane label. */
  index: number;
}

function SecondaryMapPane({ viewId, index }: SecondaryMapPaneProps) {
  const { t } = useTranslation();
  const setSecondaryBasemap = useAppStore((s) => s.setSecondaryBasemap);
  const removeSecondaryMapView = useAppStore((s) => s.removeSecondaryMapView);
  const basemapStyleUrl = useAppStore(
    (s) => s.secondaryMapViews.find((p) => p.id === viewId)?.basemapStyleUrl,
  );

  // Dedupe basemaps by style URL: two presets can share a style (e.g. Liberty
  // and Liberty 3D), and duplicate <option> values would be indistinguishable.
  const basemapOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: { value: string; name: string }[] = [];
    for (const basemap of OPENFREEMAP_BASEMAPS) {
      if (seen.has(basemap.styleUrl)) continue;
      seen.add(basemap.styleUrl);
      options.push({ value: basemap.styleUrl, name: basemap.name });
    }
    return options;
  }, []);

  return (
    <div className="relative isolate min-h-0 min-w-0 overflow-hidden bg-background">
      <SecondaryMapCanvas viewId={viewId} />
      <div className="pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-1.5">
        <Select
          className="pointer-events-auto w-36 shadow-sm"
          aria-label={t("mapGrid.basemapLabel", { number: index + 2 })}
          value={basemapStyleUrl ?? ""}
          onChange={(event) =>
            setSecondaryBasemap(viewId, { basemapStyleUrl: event.target.value })
          }
        >
          {basemapOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.name}
            </option>
          ))}
          <option value={BLANK_BASEMAP}>{t("mapGrid.basemapBlank")}</option>
        </Select>
      </div>
      <button
        type="button"
        className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md border border-input bg-background/90 text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
        aria-label={t("mapGrid.removePane", { number: index + 2 })}
        onClick={() => removeSecondaryMapView(viewId)}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
