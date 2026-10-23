/**
 * Paste a style document instead of being made to find a file.
 *
 * Shared by the Layers panel's actions menu and the Style panel header, because those are two
 * different moments — someone browsing their layers, and someone already editing symbology — and a
 * second copy of this would drift from the first.
 *
 * The dialog owns the reading. Errors stay here rather than becoming a layer-row note: the user is
 * looking straight at the box, and closing on a failure would lose what they pasted.
 */

import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Textarea,
} from "@geolibre/ui";
import { importStyleText, type ImportedStyle } from "@geolibre/map/style-import";
import { importedStyleErrorMessage } from "../../lib/style-import-note";
import { useTranslation } from "react-i18next";

export interface PasteStyleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Applies a style that was read to whatever the caller had selected. Throwing is caught and
   * surfaced in the dialog, so a hostile paste cannot lose the text through an error boundary.
   */
  onApply: (imported: ImportedStyle) => void;
}

export function PasteStyleDialog({ open, onOpenChange, onApply }: PasteStyleDialogProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reset on every open rather than on close, so the box is empty whatever route closed it — a
  // Cancel, an Escape, or the selected layer changing under it. Text pasted for one layer must
  // never be submitted against another.
  useEffect(() => {
    if (open) {
      setText("");
      setError(null);
    }
  }, [open]);

  // Not memoized: both callers pass an inline `onApply`, so a `useCallback` here would rebuild
  // every render anyway.
  const submit = () => {
    let imported: ReturnType<typeof importStyleText>;
    try {
      imported = importStyleText(text);
    } catch {
      setError(t("layers.importStyleError"));
      return;
    }
    if (!imported.ok) {
      setError(importedStyleErrorMessage(t, imported));
      return;
    }
    // `apply` runs the parsers' patch builders over the caller's live style; a malformed document
    // that survived parsing can still throw in here.
    try {
      onApply(imported);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("layers.importStyleError"));
      return;
    }
    // Closed on success. `onApply` returning without applying (the layer was removed while the box
    // was open) also lands here, which matches the file import: there is no row left to report on.
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("layers.importStyleFromText")}</DialogTitle>
          <DialogDescription>{t("layers.importStyleFromTextDescription")}</DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label={t("layers.importStyleFromText")}
          className="min-h-56 font-mono text-xs"
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          placeholder={t("layers.importStyleFromTextPlaceholder")}
          value={text}
        />
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={!text.trim()} onClick={submit}>
            {t("layers.importStyleFromTextApply")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
