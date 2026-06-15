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
import { useTranslation } from "react-i18next";
import type { AddDataKind } from "../AddDataDialog";
import { isMobile } from "../../../lib/is-mobile";
import type { AddLayerHandlers, ToolbarChrome } from "./constants";

interface AddDataMenuProps {
  chrome: ToolbarChrome;
  addLayer: AddLayerHandlers;
  osmPbfBusy: boolean;
  onSetAddDataKind: (kind: AddDataKind) => void;
  onAddGltfModel: () => void;
  onOpenOsmPbfDialog: () => void;
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
  // PostgreSQL layers are served through the Martin tile server, a local helper
  // binary with no Android build, so hide the source on mobile.
  const mobile = isMobile();

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
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("toolbar.item.sectionFiles")}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={addLayer.vector}>
          {t("toolbar.item.vectorLayer")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={addLayer.raster}>
          {t("toolbar.item.rasterLayer")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSetAddDataKind("delimited-text")}>
          {t("toolbar.layerType.delimitedText")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSetAddDataKind("gpx")}>
          {t("toolbar.layerType.gpx")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSetAddDataKind("mbtiles")}>
          {t("toolbar.layerType.mbtiles")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={osmPbfBusy} onSelect={onOpenOsmPbfDialog}>
          {t("toolbar.item.osmPbfLayer")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("toolbar.item.sectionWebServices")}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onSetAddDataKind("xyz")}>
          {t("toolbar.layerType.xyz")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSetAddDataKind("wms")}>
          {t("toolbar.layerType.wms")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSetAddDataKind("wfs")}>
          {t("toolbar.layerType.wfs")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSetAddDataKind("wmts")}>
          {t("toolbar.layerType.wmts")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSetAddDataKind("arcgis")}>
          {t("toolbar.layerType.arcgis")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={addLayer.stac}>
          {t("toolbar.item.stacLayer")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSetAddDataKind("video")}>
          {t("toolbar.layerType.video")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSetAddDataKind("deckgl-viz")}>
          {t("toolbar.layerType.deckglViz")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("toolbar.item.sectionCloudFormats")}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={addLayer.vector}>
          {t("toolbar.item.geoparquetLayer")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={addLayer.flatGeobuf}>
          {t("toolbar.item.flatgeobufLayer")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={addLayer.pmtiles}>
          {t("toolbar.item.pmtilesLayer")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={addLayer.zarr}>
          {t("toolbar.item.zarrLayer")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={addLayer.netcdf}>
          {t("toolbar.item.netcdfHdf")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("toolbar.item.section3dLayers")}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={addLayer.lidar}>
          {t("toolbar.item.lidarLayer")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={addLayer.splatting}>
          {t("toolbar.item.splattingLayer")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={addLayer.threeDTiles}>
          {t("toolbar.item.threeDTilesLayer")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onAddGltfModel}>
          {t("toolbar.layerType.gltfModel")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("toolbar.item.sectionDatabases")}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={addLayer.duckdb}>
          {t("toolbar.item.duckdbLayer")}
        </DropdownMenuItem>
        {!mobile && (
          <DropdownMenuItem onSelect={() => onSetAddDataKind("postgres")}>
            {t("toolbar.layerType.postgres")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
