import { useTranslation } from "react-i18next";
import type { PrintLayoutConfig } from "@geolibre/core";
import { Button, Label } from "@geolibre/ui";
import { Crop, RotateCcw } from "lucide-react";

interface PrintExtentEditorProps {
  captureMode: PrintLayoutConfig["captureMode"];
  extentBbox: PrintLayoutConfig["extentBbox"];
  drawingExtent: boolean;
  /** The primary renderer; the globe gets its own drawing hint. */
  renderer: string;
  onDrawExtent: () => Promise<void>;
  onClearExtent: () => void;
  onSetMode: (mode: "viewport" | "extent") => void;
}

/** The map frame's print extent (GH #523): draw a box, or use the viewport. */
export function PrintExtentEditor({
  captureMode,
  extentBbox,
  drawingExtent,
  renderer,
  onDrawExtent,
  onClearExtent,
  onSetMode,
}: PrintExtentEditorProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <Label>{t("printLayout.extent.label")}</Label>
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        disabled={drawingExtent}
        onClick={() => void onDrawExtent()}
      >
        <Crop className="me-2 h-4 w-4" />
        {extentBbox ? t("printLayout.extent.redraw") : t("printLayout.extent.draw")}
      </Button>
      {extentBbox && (
        <div className="space-y-1.5 pt-1">
          <fieldset className="m-0 space-y-1.5 border-0 p-0">
            <legend className="sr-only">{t("printLayout.extent.label")}</legend>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="capture-mode"
                className="h-4 w-4 accent-primary"
                checked={captureMode === "viewport"}
                onChange={() => onSetMode("viewport")}
              />
              {t("printLayout.extent.useViewport")}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="capture-mode"
                className="h-4 w-4 accent-primary"
                checked={captureMode === "extent"}
                onChange={() => onSetMode("extent")}
              />
              {t("printLayout.extent.useCustom")}
            </label>
          </fieldset>
          <Button variant="ghost" size="sm" onClick={onClearExtent}>
            <RotateCcw className="me-1.5 h-3.5 w-3.5" />
            {t("printLayout.extent.clear")}
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {t(renderer === "cesium" ? "rasterSubset.drawHint" : "printLayout.extent.hint")}
      </p>
    </div>
  );
}
