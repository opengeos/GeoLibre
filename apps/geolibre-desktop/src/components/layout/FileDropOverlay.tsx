import { useTranslation } from "react-i18next";

/** The full-shell hint shown while files are dragged over the window. */
export function FileDropOverlay() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="file-drop-overlay"
      className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
    >
      <div className="max-w-sm rounded-md border bg-background px-4 py-3 text-center shadow-lg">
        <p className="text-sm font-medium">{t("toolbar.fileDrop.overlayTitle")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("toolbar.fileDrop.overlaySubtext")}</p>
      </div>
    </div>
  );
}
