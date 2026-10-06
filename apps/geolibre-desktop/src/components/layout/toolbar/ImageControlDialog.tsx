import {
  type ComponentImageState,
  DEFAULT_IMAGE_STATE,
  IMAGE_RATIO_MAX,
  IMAGE_RATIO_MIN,
  IMAGE_SIZE_MAX,
  IMAGE_SIZE_MIN,
  type ImageSizeMode,
  formatAspectRatio,
  getImageControlState,
  normalizeImageUrl,
  parseAspectRatio,
} from "@geolibre/plugins";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
} from "@geolibre/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { ToolbarPanels } from "../../../hooks/useToolbarPanels";
import {
  isImageControlDialogOpen,
  setImageControlDialogOpen,
  subscribeImageControlDialog,
} from "../../../lib/image-control-dialog-store";

type Field = "url" | "width" | "height" | "ratio";

/**
 * Dialog for the Image control: an image URL plus how it is sized (width only,
 * width and height, or width and aspect ratio) and which map corner it sits in.
 * Applying puts the image on the map; Remove takes it off.
 *
 * @param props - The Image panel handlers from `useToolbarPanels`.
 * @returns The dialog.
 */
export function ImageControlDialog({ panel }: { panel: ToolbarPanels["image"] }) {
  const { t } = useTranslation();
  const open = useSyncExternalStore(
    subscribeImageControlDialog,
    isImageControlDialogOpen,
    isImageControlDialogOpen,
  );
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<ImageSizeMode>(DEFAULT_IMAGE_STATE.sizeMode);
  const [width, setWidth] = useState(String(DEFAULT_IMAGE_STATE.width));
  const [height, setHeight] = useState(String(DEFAULT_IMAGE_STATE.height));
  const [ratio, setRatio] = useState(formatAspectRatio(DEFAULT_IMAGE_STATE.ratio));
  const [position, setPosition] = useState<ComponentImageState["position"]>(
    DEFAULT_IMAGE_STATE.position,
  );
  const [invalid, setInvalid] = useState<Field | null>(null);

  // Start from what is on the map (editing) or from the defaults (adding).
  useEffect(() => {
    if (!open) return;
    const current = getImageControlState() ?? DEFAULT_IMAGE_STATE;
    setUrl(current.url);
    setMode(current.sizeMode);
    setWidth(String(current.width));
    setHeight(String(current.height));
    setRatio(formatAspectRatio(current.ratio));
    setPosition(current.position);
    setInvalid(null);
  }, [open]);

  const parseSize = (text: string): number | null => {
    const value = Number(text);
    return Number.isFinite(value) && value >= IMAGE_SIZE_MIN && value <= IMAGE_SIZE_MAX
      ? Math.round(value)
      : null;
  };

  const apply = () => {
    const nextUrl = normalizeImageUrl(url);
    if (!nextUrl) return setInvalid("url");
    const nextWidth = parseSize(width);
    if (nextWidth === null) return setInvalid("width");
    const nextHeight = mode === "fixed" ? parseSize(height) : DEFAULT_IMAGE_STATE.height;
    if (nextHeight === null) return setInvalid("height");
    const nextRatio = mode === "ratio" ? parseAspectRatio(ratio) : DEFAULT_IMAGE_STATE.ratio;
    if (nextRatio === null) return setInvalid("ratio");
    panel.apply({
      url: nextUrl,
      sizeMode: mode,
      width: nextWidth,
      height: nextHeight,
      ratio: nextRatio,
      position,
    });
    setImageControlDialogOpen(false);
  };

  const field = (name: Field, label: string, input: React.ReactNode, message: string) => (
    <div className="space-y-1">
      <Label>{label}</Label>
      {input}
      {invalid === name && <p className="text-xs text-amber-600">{message}</p>}
    </div>
  );

  const clearInvalid = () => setInvalid(null);
  const sizeRange = t("imageControl.sizeRange", { min: IMAGE_SIZE_MIN, max: IMAGE_SIZE_MAX });

  return (
    <Dialog open={open} onOpenChange={setImageControlDialogOpen}>
      <DialogContent className="max-w-md" data-testid="image-control-dialog">
        <DialogHeader>
          <DialogTitle>{t("imageControl.title")}</DialogTitle>
          <DialogDescription>{t("imageControl.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {field(
            "url",
            t("imageControl.url"),
            <Input
              type="url"
              value={url}
              placeholder="https://example.com/logo.png"
              aria-invalid={invalid === "url"}
              onChange={(event) => {
                setUrl(event.target.value);
                clearInvalid();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") apply();
              }}
            />,
            t("imageControl.urlInvalid"),
          )}
          <div className="space-y-1">
            <Label>{t("imageControl.sizeMode")}</Label>
            <Select
              value={mode}
              aria-label={t("imageControl.sizeMode")}
              onChange={(event) => {
                setMode(event.target.value as ImageSizeMode);
                clearInvalid();
              }}
            >
              <option value="auto">{t("imageControl.mode.auto")}</option>
              <option value="fixed">{t("imageControl.mode.fixed")}</option>
              <option value="ratio">{t("imageControl.mode.ratio")}</option>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {field(
              "width",
              t("imageControl.width"),
              <Input
                type="number"
                min={IMAGE_SIZE_MIN}
                max={IMAGE_SIZE_MAX}
                value={width}
                aria-invalid={invalid === "width"}
                onChange={(event) => {
                  setWidth(event.target.value);
                  clearInvalid();
                }}
              />,
              sizeRange,
            )}
            {mode === "fixed" &&
              field(
                "height",
                t("imageControl.height"),
                <Input
                  type="number"
                  min={IMAGE_SIZE_MIN}
                  max={IMAGE_SIZE_MAX}
                  value={height}
                  aria-invalid={invalid === "height"}
                  onChange={(event) => {
                    setHeight(event.target.value);
                    clearInvalid();
                  }}
                />,
                sizeRange,
              )}
            {mode === "ratio" &&
              field(
                "ratio",
                t("imageControl.ratio"),
                <Input
                  value={ratio}
                  placeholder="16:9"
                  aria-invalid={invalid === "ratio"}
                  onChange={(event) => {
                    setRatio(event.target.value);
                    clearInvalid();
                  }}
                />,
                t("imageControl.ratioInvalid", { min: IMAGE_RATIO_MIN, max: IMAGE_RATIO_MAX }),
              )}
          </div>
          <div className="space-y-1">
            <Label>{t("imageControl.position")}</Label>
            <Select
              value={position}
              aria-label={t("imageControl.position")}
              onChange={(event) => setPosition(event.target.value as typeof position)}
            >
              <option value="top-left">{t("imageControl.corner.topLeft")}</option>
              <option value="top-right">{t("imageControl.corner.topRight")}</option>
              <option value="bottom-left">{t("imageControl.corner.bottomLeft")}</option>
              <option value="bottom-right">{t("imageControl.corner.bottomRight")}</option>
            </Select>
          </div>
          <div className="flex justify-between gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              disabled={!panel.visible}
              onClick={() => {
                panel.remove();
                setImageControlDialogOpen(false);
              }}
            >
              {t("imageControl.remove")}
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setImageControlDialogOpen(false)}
              >
                {t("imageControl.cancel")}
              </Button>
              <Button type="button" onClick={apply}>
                {panel.visible ? t("imageControl.update") : t("imageControl.add")}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
