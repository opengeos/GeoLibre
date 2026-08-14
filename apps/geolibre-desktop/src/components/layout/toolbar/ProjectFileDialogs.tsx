import { useAppStore } from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@geolibre/ui";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  LARGE_EMBED_WARNING_BYTES,
  type ProjectFileActions,
} from "../../../hooks/useProjectFileActions";
import { SaveTemplateDialog } from "../SaveTemplateDialog";

interface ProjectFileDialogsProps {
  projectFiles: ProjectFileActions;
}

/** The project-file dialogs: Open-from-URL, the error dialog, the save-name prompt, and the env-var strip prompt. */
export function ProjectFileDialogs({ projectFiles }: ProjectFileDialogsProps) {
  const { t } = useTranslation();

  // The save-name prompt is cleared to null synchronously on submit/cancel,
  // before the dialog's exit animation finishes. Keep the last non-null copy so
  // its title/label text stays put through the close transition instead of
  // flashing blank.
  const lastSaveNamePrompt = useRef<typeof projectFiles.saveNamePrompt>(null);
  if (projectFiles.saveNamePrompt) {
    lastSaveNamePrompt.current = projectFiles.saveNamePrompt;
  }
  const saveNameLabels = projectFiles.saveNamePrompt ?? lastSaveNamePrompt.current;

  return (
    <>
      <Dialog
        open={projectFiles.projectUrlDialogOpen}
        onOpenChange={projectFiles.handleProjectUrlDialogOpenChange}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.openProjectFromUrl")}</DialogTitle>
            <DialogDescription>{t("toolbar.item.openProjectFromUrlDesc")}</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={projectFiles.handleOpenFromUrl}>
            <div className="space-y-2">
              <Label htmlFor="project-url">{t("toolbar.item.projectUrl")}</Label>
              <Input
                id="project-url"
                placeholder="https://example.com/project.geolibre.json"
                value={projectFiles.projectUrl}
                onChange={(event) => {
                  projectFiles.setProjectUrl(event.target.value);
                  projectFiles.setProjectUrlError(null);
                }}
              />
              {projectFiles.projectUrlError ? (
                <p className="text-xs text-destructive">{projectFiles.projectUrlError}</p>
              ) : null}
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => projectFiles.setProjectUrlDialogOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={projectFiles.projectUrlLoading}>
                {projectFiles.projectUrlLoading
                  ? t("toolbar.item.opening")
                  : t("toolbar.item.open")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={projectFiles.arcgisImportWarnings !== null}
        onOpenChange={(open: boolean) => {
          if (!open) projectFiles.setArcgisImportWarnings(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.arcgisImportComplete")}</DialogTitle>
            <DialogDescription>
              {t("toolbar.item.arcgisImportWarnings", {
                count: projectFiles.arcgisImportWarnings?.length ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-64 space-y-2 overflow-y-auto text-sm">
            {projectFiles.arcgisImportWarnings?.map((warning, index) => (
              <li key={`${warning.layerName}-${index}`}>
                <strong>{warning.layerName}:</strong>{" "}
                {t(`toolbar.item.arcgisImportReason.${warning.reason}`, {
                  layerType: warning.layerType || t("toolbar.item.arcgisUnknownLayerType"),
                })}
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button onClick={() => projectFiles.setArcgisImportWarnings(null)}>
              {t("common.ok")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={projectFiles.actionError !== null}
        onOpenChange={(open: boolean) => {
          if (!open) projectFiles.setActionError(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.somethingWentWrong")}</DialogTitle>
            <DialogDescription>{projectFiles.actionError}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button onClick={() => projectFiles.setActionError(null)}>
              {t("toolbar.item.dismiss")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={projectFiles.qgisImportWarnings !== null}
        onOpenChange={(open: boolean) => {
          if (!open) projectFiles.setQgisImportWarnings(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.qgisImportComplete")}</DialogTitle>
            <DialogDescription>
              {t("toolbar.item.qgisImportWarnings", {
                count: projectFiles.qgisImportWarnings?.length ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-64 space-y-2 overflow-y-auto text-sm">
            {projectFiles.qgisImportWarnings?.map((warning, index) => (
              <li key={`${warning.layerName}-${index}`}>
                <strong>{warning.layerName}:</strong>{" "}
                {t(`toolbar.item.qgisImportReason.${warning.reason}`, {
                  provider: warning.provider || t("toolbar.item.qgisUnknownProvider"),
                })}
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button onClick={() => projectFiles.setQgisImportWarnings(null)}>
              {t("common.ok")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={projectFiles.saveNamePrompt !== null}
        onOpenChange={(open: boolean) => {
          if (!open) projectFiles.cancelSaveNamePrompt();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{saveNameLabels?.title}</DialogTitle>
            <DialogDescription>{saveNameLabels?.description}</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={projectFiles.submitSaveNamePrompt}>
            <div className="space-y-2">
              <Label htmlFor="save-project-name">{saveNameLabels?.label}</Label>
              <Input
                id="save-project-name"
                autoFocus
                placeholder={saveNameLabels?.placeholder}
                value={projectFiles.saveNameInput}
                onChange={(event) => projectFiles.setSaveNameInput(event.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => projectFiles.cancelSaveNamePrompt()}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!projectFiles.saveNameInput.trim()}>
                {t("common.save")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={projectFiles.credentialStripPrompt !== null}
        onOpenChange={(open: boolean) => {
          if (!open) projectFiles.resolveCredentialStripPrompt("cancel");
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("settings.env.stripPromptTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.env.stripPromptDesc", {
                count: projectFiles.credentialStripPrompt?.count ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => projectFiles.resolveCredentialStripPrompt("cancel")}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="outline"
              onClick={() => projectFiles.resolveCredentialStripPrompt("keep")}
            >
              {t("settings.env.keepButton")}
            </Button>
            <Button onClick={() => projectFiles.resolveCredentialStripPrompt("strip")}>
              {t("settings.env.stripButton")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={projectFiles.embedVectorDataPrompt !== null}
        onOpenChange={(open: boolean) => {
          if (!open) projectFiles.resolveEmbedVectorDataPrompt("cancel");
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.embedVectorTitle")}</DialogTitle>
            <DialogDescription>
              {t(
                projectFiles.embedVectorDataPrompt?.desktop
                  ? "toolbar.item.embedVectorDescDesktop"
                  : "toolbar.item.embedVectorDesc",
                {
                  count: projectFiles.embedVectorDataPrompt?.count ?? 0,
                  size: formatByteSize(projectFiles.embedVectorDataPrompt?.bytes ?? 0),
                },
              )}
            </DialogDescription>
          </DialogHeader>
          {(projectFiles.embedVectorDataPrompt?.bytes ?? 0) >= LARGE_EMBED_WARNING_BYTES ? (
            <p
              role="alert"
              className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300"
            >
              {t("toolbar.item.embedVectorLargeWarning", {
                size: formatByteSize(projectFiles.embedVectorDataPrompt?.bytes ?? 0),
              })}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => projectFiles.resolveEmbedVectorDataPrompt("cancel")}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="outline"
              onClick={() => projectFiles.resolveEmbedVectorDataPrompt("noembed")}
            >
              {t(
                projectFiles.embedVectorDataPrompt?.desktop
                  ? "toolbar.item.embedVectorReferenceButton"
                  : "toolbar.item.embedVectorSkipButton",
              )}
            </Button>
            <Button onClick={() => projectFiles.resolveEmbedVectorDataPrompt("embed")}>
              {t("toolbar.item.embedVectorEmbedButton")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <SaveTemplateDialog
        open={projectFiles.saveTemplateDialogOpen}
        onOpenChange={projectFiles.setSaveTemplateDialogOpen}
        getProject={() => {
          const { project } = projectFiles.buildCurrentProject();
          const currentName = useAppStore.getState().projectName;
          return { project, defaultProjectName: currentName };
        }}
      />
    </>
  );
}

/**
 * Formats a byte count as a short, human-readable size (e.g. "3.4 MB") for the
 * embed-data prompt's size warning.
 *
 * @param bytes - The size in bytes.
 * @returns A localized-ish size string with one decimal for MB and above.
 */
function formatByteSize(bytes: number): string {
  // One decimal, with the user's locale decimal separator (e.g. "3,4 MB").
  const oneDecimal = (value: number) =>
    value.toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  // < 1023.5 so a value that rounds up to 1024 prints "1.0 MB", not "1024 KB".
  if (kb < 1023.5) return `${Math.round(kb).toLocaleString()} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${oneDecimal(mb)} MB`;
  const gb = mb / 1024;
  return `${oneDecimal(gb)} GB`;
}
