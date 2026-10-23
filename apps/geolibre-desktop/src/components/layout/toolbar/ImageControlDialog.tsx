import {
  type ComponentImageState,
  DEFAULT_IMAGE_STATE,
  IMAGE_RATIO_MAX,
  IMAGE_RATIO_MIN,
  IMAGE_SIZE_MAX,
  IMAGE_SIZE_MIN,
  type ImageSizeMode,
  MAX_IMAGE_CONTROLS,
  formatAspectRatio,
  normalizeImageUrl,
  isRatioHeightInRange,
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
import { Pencil, Trash2 } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { ToolbarPanels } from "../../../hooks/useToolbarPanels";
import {
  isImageControlDialogOpen,
  setImageControlDialogOpen,
  subscribeImageControlDialog,
} from "../../../lib/image-control-dialog-store";

type Field = "url" | "width" | "height" | "ratio" | "apply" | "limit";

/**
 * Dialog for the Image control. A map can hold several images, each with a
 * collapsible header: the list shows what is on the map (edit or remove), and
 * the form adds a new image or updates the selected one: a title, a URL, how it
 * is sized (width only, width and height, or width and aspect ratio) and which
 * map corner it sits in.
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<ImageSizeMode>(DEFAULT_IMAGE_STATE.sizeMode);
  const [width, setWidth] = useState(String(DEFAULT_IMAGE_STATE.width));
  const [height, setHeight] = useState(String(DEFAULT_IMAGE_STATE.height));
  const [ratio, setRatio] = useState(formatAspectRatio(DEFAULT_IMAGE_STATE.ratio));
  const [position, setPosition] = useState<ComponentImageState["position"]>(
    DEFAULT_IMAGE_STATE.position,
  );
  const [invalid, setInvalid] = useState<Field | null>(null);

  const loadForm = (current: ComponentImageState | null) => {
    const source = current ?? DEFAULT_IMAGE_STATE;
    setEditingId(current?.id ?? null);
    setTitle(current ? current.title : t("imageControl.defaultTitle"));
    setUrl(source.url);
    setMode(source.sizeMode);
    setWidth(String(source.width));
    setHeight(String(source.height));
    setRatio(formatAspectRatio(source.ratio));
    setPosition(source.position);
    setInvalid(null);
  };

  // Each time the dialog opens, start with an empty form for a new image.
  useEffect(() => {
    if (open) loadForm(null);
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
    // The width and ratio together must give a height within the size limits.
    if (mode === "ratio" && !isRatioHeightInRange(nextWidth, nextRatio)) return setInvalid("ratio");
    if (!editingId && panel.images.length >= MAX_IMAGE_CONTROLS) return setInvalid("limit");
    const id = panel.apply({
      id: editingId ?? undefined,
      title: title.trim() || t("imageControl.defaultTitle"),
      url: nextUrl,
      sizeMode: mode,
      width: nextWidth,
      height: nextHeight,
      ratio: nextRatio,
      position,
      // Editing keeps the fold state; a new image starts expanded.
      collapsed: panel.images.find((image) => image.id === editingId)?.collapsed ?? false,
    });
    if (id === null) return setInvalid("apply");
    // Stay open, ready for the next image.
    loadForm(null);
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
          {panel.images.length > 0 && (
            <ul
              className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-1"
              aria-label={t("imageControl.listLabel")}
            >
              {panel.images.map((image) => (
                <li
                  key={image.id}
                  className={`flex items-center gap-2 rounded px-2 py-1 text-sm ${
                    image.id === editingId ? "bg-accent" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate" title={image.url}>
                    {image.title}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    title={t("imageControl.edit")}
                    aria-label={t("imageControl.editNamed", { title: image.title })}
                    onClick={() => loadForm(image)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    title={t("imageControl.remove")}
                    aria-label={t("imageControl.removeNamed", { title: image.title })}
                    onClick={() => {
                      panel.remove(image.id);
                      if (image.id === editingId) loadForm(null);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-1">
            <Label>{t("imageControl.titleField")}</Label>
            <Input
              value={title}
              maxLength={80}
              aria-label={t("imageControl.titleField")}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
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
                t("imageControl.ratioInvalid", {
                  min: IMAGE_RATIO_MIN,
                  max: IMAGE_RATIO_MAX,
                  minSize: IMAGE_SIZE_MIN,
                  maxSize: IMAGE_SIZE_MAX,
                }),
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
          {invalid === "limit" && (
            <p className="text-xs text-amber-600">
              {t("imageControl.limit", { max: MAX_IMAGE_CONTROLS })}
            </p>
          )}
          {invalid === "apply" && (
            <p className="text-xs text-amber-600">{t("imageControl.addFailed")}</p>
          )}
          <div className="flex justify-between gap-2 pt-1">
            {editingId ? (
              <Button type="button" variant="outline" onClick={() => loadForm(null)}>
                {t("imageControl.newImage")}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setImageControlDialogOpen(false)}
              >
                {t("imageControl.close")}
              </Button>
              <Button
                type="button"
                disabled={!editingId && panel.images.length >= MAX_IMAGE_CONTROLS}
                onClick={apply}
              >
                {editingId ? t("imageControl.update") : t("imageControl.add")}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
