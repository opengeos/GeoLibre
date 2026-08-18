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
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LARGE_EMBED_WARNING_BYTES,
  type RemoteSharedProjectTarget,
  type ProjectFileActions,
} from "../../../hooks/useProjectFileActions";
import type { ArcgisProjectImportWarning } from "../../../lib/arcgis-project-import";
import type { QgisProjectImportWarning } from "../../../lib/qgis-project-import";
import { fetchSharedProjectVersions, type SharedProjectVersion } from "../../../lib/share-geolibre";
import { SaveTemplateDialog } from "../SaveTemplateDialog";
import { ImportWarningList } from "./ImportWarningList";

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

  // Stable identities so the warning lists regroup only when the warnings change.
  const describeArcgisWarning = useCallback(
    (warning: ArcgisProjectImportWarning) =>
      t(`toolbar.item.arcgisImportReason.${warning.reason}`, {
        layerType: warning.layerType || t("toolbar.item.arcgisUnknownLayerType"),
      }),
    [t],
  );
  const describeQgisWarning = useCallback(
    (warning: QgisProjectImportWarning) =>
      t(`toolbar.item.qgisImportReason.${warning.reason}`, {
        provider: warning.provider || t("toolbar.item.qgisUnknownProvider"),
      }),
    [t],
  );

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
          <ImportWarningList
            warnings={projectFiles.arcgisImportWarnings ?? []}
            describe={describeArcgisWarning}
          />
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
      <SharedProjectVersionsDialog
        target={projectFiles.remoteSaveWarning}
        onClose={projectFiles.clearRemoteSaveWarning}
        onOpenVersion={(rawUrl, token) =>
          projectFiles.openProjectFromShareUrl(rawUrl, { authToken: token, asCopy: true })
        }
      />
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
          <ImportWarningList
            warnings={projectFiles.qgisImportWarnings ?? []}
            describe={describeQgisWarning}
          />
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

function SharedProjectVersionsDialog({
  target,
  onClose,
  onOpenVersion,
}: {
  target: RemoteSharedProjectTarget | null;
  onClose: () => void;
  onOpenVersion: (rawUrl: string, token: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<SharedProjectVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const handleClose = () => {
    setShowHistory(false);
    onClose();
  };

  useEffect(() => {
    if (!target || !showHistory) return;
    const controller = new AbortController();
    setVersions([]);
    setError(null);
    setLoading(true);
    void fetchSharedProjectVersions({
      token: target.token,
      projectId: target.id,
      baseUrl: target.baseUrl,
      signal: controller.signal,
    })
      .then((items) => {
        if (!controller.signal.aborted) setVersions(items);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : t("toolbar.item.serverHistoryError"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [target, showHistory, t]);

  return (
    <Dialog open={target !== null} onOpenChange={(open: boolean) => !open && handleClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t(
              showHistory
                ? "toolbar.item.serverHistoryTitle"
                : "toolbar.item.sharedSaveWarningTitle",
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              showHistory
                ? "toolbar.item.serverHistoryDescription"
                : "toolbar.item.sharedSaveWarningDescription",
            )}
          </DialogDescription>
        </DialogHeader>
        {!showHistory ? null : loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("toolbar.item.loadingServerHistory")}
          </p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("toolbar.item.emptyServerHistory")}</p>
        ) : (
          <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
            {versions.map((version) => (
              <li key={version.number} className="flex items-center gap-3 p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {t("toolbar.item.serverVersion", { version: version.number })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {version.createdAt
                      ? new Date(version.createdAt).toLocaleString()
                      : t("toolbar.item.serverVersionDateUnknown")}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (!target) return;
                    void onOpenVersion(version.rawUrl, target.token)
                      .then(handleClose)
                      .catch((caught) => {
                        setError(
                          caught instanceof Error
                            ? caught.message
                            : t("toolbar.item.serverHistoryError"),
                        );
                      });
                  }}
                >
                  {t("gallery.openCopy")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <Button variant={showHistory ? "default" : "outline"} onClick={handleClose}>
            {t("toolbar.item.dismiss")}
          </Button>
          {!showHistory ? (
            <Button onClick={() => setShowHistory(true)}>
              {t("toolbar.item.openServerHistory")}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
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
