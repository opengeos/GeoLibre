import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import { Database } from "lucide-react";
import { Fragment, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { AddDataKind } from "../AddDataDialog";
import { isMobile } from "../../../lib/is-mobile";
import { useDesktopSettingsStore } from "../../../hooks/useDesktopSettings";
import {
  DATA_SOURCE_CATALOG,
  DATA_SOURCE_SECTION_LABEL_KEYS,
  DATA_SOURCE_SECTION_ORDER,
  isDataSourceVisible,
} from "../../../lib/ui-profile";
import type { AddLayerHandlers, ToolbarChrome } from "./constants";

interface AddDataMenuProps {
  chrome: ToolbarChrome;
  addLayer: AddLayerHandlers;
  osmPbfBusy: boolean;
  onSetAddDataKind: (kind: AddDataKind) => void;
  onAddGltfModel: () => void;
  onOpenOsmPbfDialog: () => void;
}

interface AddDataItem {
  onSelect: () => void;
  disabled?: boolean;
}

/** The Add Data menu: files, web services, cloud formats, 3D layers, databases. */
export function AddDataMenu({
  chrome,
  addLayer,
  osmPbfBusy,
  onSetAddDataKind,
  onAddGltfModel,
  onOpenOsmPbfDialog,
}: AddDataMenuProps) {
  const { t } = useTranslation();
  const uiProfile = useDesktopSettingsStore(
    (state) => state.desktopSettings.uiProfile,
  );
  // PostgreSQL layers are served through the Martin tile server, a local helper
  // binary with no Android build, so hide the source on mobile.
  // The user agent is stable for the session, so evaluate once.
  const mobile = useMemo(() => isMobile(), []);

  // Map each catalog id to its dispatch. Kept here (not in the catalog) so the
  // handlers stay in scope; the catalog only owns ids, sections, and tiers.
  const handlers: Record<string, AddDataItem> = {
    vector: { onSelect: addLayer.vector },
    raster: { onSelect: addLayer.raster },
    "delimited-text": { onSelect: () => onSetAddDataKind("delimited-text") },
    gpx: { onSelect: () => onSetAddDataKind("gpx") },
    mbtiles: { onSelect: () => onSetAddDataKind("mbtiles") },
    "osm-pbf": { onSelect: onOpenOsmPbfDialog, disabled: osmPbfBusy },
    xyz: { onSelect: () => onSetAddDataKind("xyz") },
    wms: { onSelect: () => onSetAddDataKind("wms") },
    wfs: { onSelect: () => onSetAddDataKind("wfs") },
    wmts: { onSelect: () => onSetAddDataKind("wmts") },
    arcgis: { onSelect: () => onSetAddDataKind("arcgis") },
    stac: { onSelect: addLayer.stac },
    video: { onSelect: () => onSetAddDataKind("video") },
    "deckgl-viz": { onSelect: () => onSetAddDataKind("deckgl-viz") },
    // GeoParquet loads through the same vector file picker as "vector"; keep
    // both pointing at addLayer.vector if that handler ever changes.
    geoparquet: { onSelect: addLayer.vector },
    flatgeobuf: { onSelect: addLayer.flatGeobuf },
    pmtiles: { onSelect: addLayer.pmtiles },
    zarr: { onSelect: addLayer.zarr },
    netcdf: { onSelect: addLayer.netcdf },
    lidar: { onSelect: addLayer.lidar },
    splatting: { onSelect: addLayer.splatting },
    "3d-tiles": { onSelect: addLayer.threeDTiles },
    "gltf-model": { onSelect: onAddGltfModel },
    duckdb: { onSelect: addLayer.duckdb },
    postgres: { onSelect: () => onSetAddDataKind("postgres") },
  };

  // Each rendered section is the catalog entries it owns, filtered by the UI
  // profile (and the mobile rule for postgres). Sections with no visible items
  // are dropped along with their header/separator.
  const sections = DATA_SOURCE_SECTION_ORDER.map((section) => ({
    section,
    entries: DATA_SOURCE_CATALOG.filter(
      (entry) =>
        entry.section === section &&
        isDataSourceVisible(uiProfile, entry.id) &&
        !(entry.id === "postgres" && mobile),
    ),
  })).filter((group) => group.entries.length > 0);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={chrome.buttonClass}
          variant="ghost"
          size={chrome.buttonSize}
          aria-label={t("toolbar.menu.addData")}
        >
          <Database className={chrome.iconClassName} />
          {chrome.renderLabel(t("toolbar.menu.addData"))}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{t("toolbar.menu.addData")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {sections.map((group, index) => (
          <Fragment key={group.section}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t(DATA_SOURCE_SECTION_LABEL_KEYS[group.section])}
            </DropdownMenuLabel>
            {group.entries.map((entry) => {
              const item = handlers[entry.id];
              if (!item) return null;
              return (
                <DropdownMenuItem
                  key={entry.id}
                  disabled={item.disabled}
                  onSelect={item.onSelect}
                >
                  {t(entry.labelKey)}
                </DropdownMenuItem>
              );
            })}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
