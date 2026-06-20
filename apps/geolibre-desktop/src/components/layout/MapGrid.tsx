import { useAppStore } from "@geolibre/core";
import { SecondaryMapCanvas } from "@geolibre/map";
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import { Layers, X } from "lucide-react";
import { type ReactNode } from "react";
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
 * entry into a CSS grid. Every pane shares the primary's basemap and layers;
 * each secondary pane carries a layer-visibility toggle so it can show a
 * different subset of the shared layers, plus a button to drop the pane. Camera
 * sync between panes is handled inside the canvases (via the shared global
 * `mapView`); this component only owns layout and chrome.
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
  const removeSecondaryMapView = useAppStore((s) => s.removeSecondaryMapView);

  return (
    <div className="relative isolate min-h-0 min-w-0 overflow-hidden bg-background">
      <SecondaryMapCanvas viewId={viewId} />
      <div className="absolute left-2 top-2 z-10">
        <PaneLayerToggle viewId={viewId} index={index} />
      </div>
      <button
        type="button"
        className="absolute bottom-2 left-2 z-10 flex h-7 w-7 items-center justify-center rounded-md border border-input bg-background/90 text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
        aria-label={t("mapGrid.removePane", { number: index + 2 })}
        onClick={() => removeSecondaryMapView(viewId)}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

interface PaneLayerToggleProps {
  viewId: string;
  index: number;
}

/**
 * A dropdown of the shared layers with a checkbox each, controlling which layers
 * are visible in this pane. A layer's checkbox reflects its effective visibility
 * (the pane's override, or the primary map's visibility when not overridden).
 */
function PaneLayerToggle({ viewId, index }: PaneLayerToggleProps) {
  const { t } = useTranslation();
  const layers = useAppStore((s) => s.layers);
  const layerVisibility = useAppStore(
    (s) => s.secondaryMapViews.find((p) => p.id === viewId)?.layerVisibility,
  );
  const setSecondaryLayerVisibility = useAppStore(
    (s) => s.setSecondaryLayerVisibility,
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 bg-background/90 px-2 shadow-sm"
          aria-label={t("mapGrid.layersLabel", { number: index + 2 })}
        >
          <Layers className="h-3.5 w-3.5" />
          {t("mapGrid.layers")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-auto">
        <DropdownMenuLabel>{t("mapGrid.layers")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {layers.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            {t("mapGrid.noLayers")}
          </div>
        ) : (
          layers.map((layer) => {
            const override = layerVisibility?.[layer.id];
            const visible = override === undefined ? layer.visible : override;
            return (
              <DropdownMenuCheckboxItem
                key={layer.id}
                checked={visible}
                onCheckedChange={(checked: boolean) =>
                  setSecondaryLayerVisibility(viewId, layer.id, checked)
                }
                // Keep the menu open so several layers can be toggled at once.
                onSelect={(event: Event) => event.preventDefault()}
              >
                <span className="truncate">{layer.name}</span>
              </DropdownMenuCheckboxItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
