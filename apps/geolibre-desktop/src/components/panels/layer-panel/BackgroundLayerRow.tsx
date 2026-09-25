import { useTranslation } from "react-i18next";
import { useAppStore } from "@geolibre/core";
import { defaultBlankBackgroundColor } from "@geolibre/map";
import {
  Button,
  ColorField,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Label,
} from "@geolibre/ui";
import { Eye, EyeOff, GripVertical, Layers, MoreHorizontal, Palette } from "lucide-react";
import type { ThemeMode } from "../../../hooks/useThemeMode";
import { BACKGROUND_SELECTION_ID } from "./layer-panel-utils";
import { LayerOpacitySlider } from "./LayerOpacitySlider";

interface BackgroundLayerRowProps {
  /** Whether the background card is the panel's current selection. */
  selected: boolean;
  basemapVisible: boolean;
  /** Whether the Blank basemap is active, which offers the appearance dialog. */
  blankBackgroundActive: boolean;
  onOpenBasemapPicker: () => void;
  onOpenAppearance: () => void;
}

/** The fixed Background card at the bottom of the layer list (the basemap). */
export function BackgroundLayerRow({
  selected,
  basemapVisible,
  blankBackgroundActive,
  onOpenBasemapPicker,
  onOpenAppearance,
}: BackgroundLayerRowProps) {
  const { t } = useTranslation();
  const selectLayer = useAppStore((s) => s.selectLayer);
  const basemapOpacity = useAppStore((s) => s.basemapOpacity);
  const setBasemapVisible = useAppStore((s) => s.setBasemapVisible);
  const setBasemapOpacity = useAppStore((s) => s.setBasemapOpacity);
  return (
    <div
      data-layer-card=""
      className={`rounded-md border p-2 transition-colors ${
        selected
          ? "border-primary bg-primary/5"
          : "border-border bg-background hover:border-muted-foreground/40 hover:bg-muted/20"
      }`}
      title={t("layers.doubleClickToChangeBackground")}
      onClick={() => selectLayer(BACKGROUND_SELECTION_ID)}
      onDoubleClick={onOpenBasemapPicker}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") selectLayer(BACKGROUND_SELECTION_ID);
        // Keyboard equivalent of the double-click: Space opens the basemap
        // picker (preventDefault stops the panel from scrolling).
        if (e.key === " ") {
          e.preventDefault();
          onOpenBasemapPicker();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="flex items-center gap-1">
        <span
          title={t("layers.backgroundCannotReorder")}
          className="rounded p-0.5 text-muted-foreground/50"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>
        <button
          type="button"
          className="rounded p-0.5 hover:bg-muted"
          title={basemapVisible ? t("layers.hideBackground") : t("layers.showBackground")}
          aria-label={basemapVisible ? t("layers.hideBackground") : t("layers.showBackground")}
          onClick={(e) => {
            e.stopPropagation();
            setBasemapVisible(!basemapVisible);
          }}
        >
          {basemapVisible ? (
            <Eye className="h-3.5 w-3.5" />
          ) : (
            <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </button>
        <Layers className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium">{t("layers.background")}</span>
        <span className="text-[10px] uppercase text-muted-foreground">
          {t("layers.typeBackground")}
        </span>
        {blankBackgroundActive ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={t("layers.backgroundAppearance")}
            aria-label={t("layers.backgroundAppearance")}
            onClick={(e) => {
              e.stopPropagation();
              onOpenAppearance();
            }}
          >
            <Palette className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={t("layers.changeBackground")}
          aria-label={t("layers.changeBackground")}
          onClick={(e) => {
            e.stopPropagation();
            onOpenBasemapPicker();
          }}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </div>
      <LayerOpacitySlider
        label={t("layers.opacity")}
        ariaLabel={t("layers.backgroundOpacity")}
        value={basemapOpacity}
        onChange={setBasemapOpacity}
      />
    </div>
  );
}

interface BackgroundAppearanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  themeMode: ThemeMode;
}

/** Colour and opacity of the Blank basemap background. */
export function BackgroundAppearanceDialog({
  open,
  onOpenChange,
  themeMode,
}: BackgroundAppearanceDialogProps) {
  const { t } = useTranslation();
  const basemapOpacity = useAppStore((s) => s.basemapOpacity);
  const blankBackgroundColor = useAppStore((s) => s.blankBackgroundColor);
  const setBasemapOpacity = useAppStore((s) => s.setBasemapOpacity);
  const setBlankBackgroundColor = useAppStore((s) => s.setBlankBackgroundColor);
  const effectiveBlankBackgroundColor =
    blankBackgroundColor ?? defaultBlankBackgroundColor(themeMode === "dark");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("layers.blankBackground")}</DialogTitle>
          <DialogDescription>{t("layers.blankBackgroundDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="blank-background-color">{t("layers.color")}</Label>
            <ColorField
              id="blank-background-color"
              value={effectiveBlankBackgroundColor}
              onChange={setBlankBackgroundColor}
              allowTransparent={false}
              eyedropperLabel={t("common.pickColorFromScreen")}
            />
          </div>
          <LayerOpacitySlider
            label={t("layers.opacity")}
            ariaLabel={t("layers.backgroundOpacity")}
            value={basemapOpacity}
            onChange={setBasemapOpacity}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
