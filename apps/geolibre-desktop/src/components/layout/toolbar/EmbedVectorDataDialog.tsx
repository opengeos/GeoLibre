/**
 * Save-project prompt asking how to persist local or edited vector layers:
 * embed in the project, save file references, save edits back to sources, or
 * save external copies (issue #3528).
 */

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import { useTranslation } from "react-i18next";
import {
  LARGE_EMBED_WARNING_BYTES,
  type EmbedVectorDataPrompt,
  type EmbedVectorDataPromptChoice,
} from "../../../hooks/useProjectFileActions";

export interface EmbedVectorDataDialogProps {
  prompt: EmbedVectorDataPrompt | null;
  exportingEditedCopiesZip: boolean;
  onResolve: (choice: EmbedVectorDataPromptChoice) => void;
  onExportEditedCopiesZip: (layerIds: string[]) => Promise<boolean>;
}

/**
 * Formats a byte count as a short, human-readable size (e.g. "3.4 MB") for the
 * embed-data prompt's size warning.
 */
function formatByteSize(bytes: number): string {
  const oneDecimal = (value: number) =>
    value.toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1023.5) return `${Math.round(kb).toLocaleString()} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${oneDecimal(mb)} MB`;
  const gb = mb / 1024;
  return `${oneDecimal(gb)} GB`;
}

export function EmbedVectorDataDialog({
  prompt,
  exportingEditedCopiesZip,
  onResolve,
  onExportEditedCopiesZip,
}: EmbedVectorDataDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open: boolean) => {
        if (!open) onResolve("cancel");
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t(
              prompt?.hasGeometryEdits
                ? "toolbar.item.embedEditedVectorTitle"
                : "toolbar.item.embedVectorTitle",
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              prompt?.hasGeometryEdits
                ? "toolbar.item.embedEditedFeaturesDesc"
                : prompt?.allowFileReferences
                  ? "toolbar.item.embedVectorDescDesktop"
                  : prompt?.desktop
                    ? "toolbar.item.embedVectorDescMas"
                    : "toolbar.item.embedVectorDesc",
              {
                count: prompt?.count ?? 0,
                size: formatByteSize(prompt?.bytes ?? 0),
              },
            )}
          </DialogDescription>
        </DialogHeader>
        {(prompt?.bytes ?? 0) >= LARGE_EMBED_WARNING_BYTES ? (
          <p
            role="alert"
            className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300"
          >
            {t("toolbar.item.embedVectorLargeWarning", {
              size: formatByteSize(prompt?.bytes ?? 0),
            })}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => onResolve("cancel")}>
            {t("common.cancel")}
          </Button>
          {prompt?.hasGeometryEdits &&
          prompt?.allowFileReferences &&
          prompt?.allowExportData &&
          (prompt?.exportableEditedCount ?? 0) > 0 ? (
            <Button variant="outline" onClick={() => onResolve("save-copies")}>
              {t("toolbar.item.embedVectorSaveCopiesButton")}
            </Button>
          ) : null}
          {prompt?.hasGeometryEdits &&
          !prompt?.allowFileReferences &&
          prompt?.allowExportData &&
          (prompt?.exportableEditedCount ?? 0) > 0 ? (
            <Button
              variant="outline"
              disabled={exportingEditedCopiesZip}
              onClick={() => void onExportEditedCopiesZip(prompt?.editedExportableLayerIds ?? [])}
            >
              {t("toolbar.item.embedVectorExportCopiesZipButton")}
            </Button>
          ) : null}
          {prompt?.hasGeometryEdits &&
          prompt?.allowFileReferences &&
          (prompt?.writableEditedCount ?? 0) > 0 ? (
            <Button variant="secondary" onClick={() => onResolve("overwrite-sources")}>
              {t("toolbar.item.embedVectorOverwriteSourcesButton")}
            </Button>
          ) : null}
          {prompt?.allowFileReferences || !prompt?.desktop ? (
            <Button variant="outline" onClick={() => onResolve("noembed")}>
              {t(
                prompt?.desktop
                  ? "toolbar.item.embedVectorReferenceButton"
                  : "toolbar.item.embedVectorSkipButton",
              )}
            </Button>
          ) : null}
          <Button onClick={() => onResolve("embed")}>
            {t("toolbar.item.embedVectorEmbedButton")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
