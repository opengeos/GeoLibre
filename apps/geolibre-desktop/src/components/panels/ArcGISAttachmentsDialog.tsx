import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import {
  addArcGISAttachment,
  deleteArcGISAttachments,
  downloadArcGISAttachment,
  listArcGISAttachments,
  updateArcGISAttachment,
  type ArcGISAttachmentInfo,
  type ArcGISAttachmentSupport,
} from "@geolibre/plugins";
import { Download, Eye, FileUp, Paperclip, RefreshCw, Replace, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  attachmentExtension,
  attachmentSaveName,
  formatAttachmentSize,
  isPreviewableAttachment,
} from "../../lib/arcgis-attachment-files";
import { saveBinaryFileWithFallback } from "../../lib/file-io/file-dialogs";

interface ArcGISAttachmentsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  layerId: string;
  layerName: string;
  /** The selected record's service object ID. */
  objectId: number;
  support: ArcGISAttachmentSupport;
}

/** One line of the outcome log: a confirmed result or an error. */
interface AttachmentStatus {
  kind: "success" | "error";
  text: string;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The files an ArcGIS service stores against one record: list, preview,
 * download, add, replace and delete. Every write goes to the service at once
 * and the list is read back afterwards, so what is shown is the service's state.
 */
export function ArcGISAttachmentsDialog({
  open,
  onOpenChange,
  layerId,
  layerName,
  objectId,
  support,
}: ArcGISAttachmentsDialogProps) {
  const { t, i18n } = useTranslation();
  const [attachments, setAttachments] = useState<ArcGISAttachmentInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<AttachmentStatus[]>([]);
  // The transfer in progress, if any: its label and how to cancel it.
  // A delete cannot be cancelled once sent, so it has no abort controller.
  const [transfer, setTransfer] = useState<{
    label: string;
    abort: AbortController | null;
  } | null>(null);
  const [preview, setPreview] = useState<{ id: number; name: string; url: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetRef = useRef<ArcGISAttachmentInfo | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  // The record a request was made for; a reply for another record is stale.
  const recordKey = `${layerId}:${objectId}`;
  const recordKeyRef = useRef(recordKey);
  recordKeyRef.current = recordKey;
  // A transfer that finishes after the dialog closes must not show a result.
  const openRef = useRef(open);
  openRef.current = open;

  const reload = useCallback(async () => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const key = `${layerId}:${objectId}`;
    // A replacement keeps the attachment ID, so a preview cannot be matched to
    // the new list by ID: every read-back starts without one.
    setPreview(null);
    setLoading(true);
    setLoadError(null);
    try {
      const list = await listArcGISAttachments(layerId, objectId, controller.signal);
      if (recordKeyRef.current !== key || controller.signal.aborted) return;
      setAttachments(list);
    } catch (error) {
      if (isAbort(error) || recordKeyRef.current !== key) return;
      setAttachments(null);
      setLoadError(errorText(error));
    } finally {
      if (loadAbortRef.current === controller) {
        loadAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [layerId, objectId]);
  // A transfer's read-back targets the current record, not the one it started on.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  // A new record (or reopening) starts from the service's current list.
  useEffect(() => {
    if (!open) return;
    setAttachments(null);
    setStatuses([]);
    setPendingDelete(null);
    void reload();
    return () => loadAbortRef.current?.abort();
  }, [open, reload]);

  // Release the preview's object URL when it is replaced, the record changes,
  // or the dialog closes, so protected content does not outlive its view.
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview.url);
  }, [preview]);
  useEffect(() => {
    setPreview(null);
  }, [recordKey, open]);

  const report = (entries: AttachmentStatus[]) => setStatuses(entries);

  /** Run one transfer at a time, with cancellation and a read-back afterwards. */
  const runTransfer = async (
    label: string,
    work: (signal: AbortSignal) => Promise<AttachmentStatus[]>,
    { readBack = true, cancellable = true } = {},
  ) => {
    const abort = new AbortController();
    setTransfer({ label, abort: cancellable ? abort : null });
    try {
      report(await work(abort.signal));
    } catch (error) {
      if (!isAbort(error)) report([{ kind: "error", text: errorText(error) }]);
    } finally {
      setTransfer(null);
      if (readBack) void reloadRef.current();
    }
  };

  const addFiles = (files: File[]) => {
    if (!files.length) return;
    void runTransfer(t("attachments.uploading", { count: files.length }), async (signal) => {
      const results: AttachmentStatus[] = [];
      // One at a time: each file gets its own confirmed or failed outcome, and
      // a cancelled batch stops before the next file instead of mid-way.
      for (const file of files) {
        if (signal.aborted) {
          results.push({ kind: "error", text: t("attachments.notSent", { name: file.name }) });
          continue;
        }
        try {
          await addArcGISAttachment(layerId, objectId, file, file.name, signal);
          results.push({ kind: "success", text: t("attachments.added", { name: file.name }) });
        } catch (error) {
          results.push({
            kind: "error",
            text: t("attachments.fileFailed", { name: file.name, message: errorText(error) }),
          });
        }
      }
      return results;
    });
  };

  const replaceFile = (target: ArcGISAttachmentInfo, file: File) => {
    void runTransfer(t("attachments.replacing", { name: target.name }), async (signal) => {
      await updateArcGISAttachment(layerId, objectId, target.id, file, file.name, signal);
      return [
        {
          kind: "success",
          text: t("attachments.replaced", { name: target.name, file: file.name }),
        },
      ];
    });
  };

  const removeAttachment = (target: ArcGISAttachmentInfo) => {
    setPendingDelete(null);
    void runTransfer(
      t("attachments.deleting", { name: target.name }),
      async () => {
        const { deleted, errors } = await deleteArcGISAttachments(layerId, objectId, [target.id]);
        return [
          ...deleted.map(() => ({
            kind: "success" as const,
            text: t("attachments.deleted", { name: target.name }),
          })),
          ...errors.map((text) => ({ kind: "error" as const, text })),
        ];
      },
      { cancellable: false },
    );
  };

  const download = (target: ArcGISAttachmentInfo) => {
    void runTransfer(
      t("attachments.downloading", { name: target.name }),
      async (signal) => {
        const blob = await downloadArcGISAttachment(layerId, objectId, target, signal);
        if (!openRef.current) return [];
        const name = attachmentSaveName(target.name);
        const ext = attachmentExtension(name);
        const saved = await saveBinaryFileWithFallback(blob, {
          defaultName: name,
          filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [],
          browserTypes: [],
          mimeType: target.contentType,
        });
        return saved ? [{ kind: "success", text: t("attachments.saved", { name: saved }) }] : [];
      },
      { readBack: false },
    );
  };

  const showPreview = (target: ArcGISAttachmentInfo) => {
    const key = recordKey;
    void runTransfer(
      t("attachments.loadingPreview", { name: target.name }),
      async (signal) => {
        const blob = await downloadArcGISAttachment(layerId, objectId, target, signal);
        if (openRef.current && recordKeyRef.current === key) {
          setPreview({ id: target.id, name: target.name, url: URL.createObjectURL(blob) });
        }
        return [];
      },
      { readBack: false },
    );
  };

  const busy = transfer !== null;
  const canWrite = support.add || support.update || support.delete;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Paperclip className="h-4 w-4" />
            {t("attachments.title")}
          </DialogTitle>
          <DialogDescription>
            {t("attachments.description", { objectId, layer: layerName })}
            {canWrite ? ` ${t("attachments.savesDirectly")}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          {support.add ? (
            <Button size="sm" disabled={busy} onClick={() => addInputRef.current?.click()}>
              <FileUp className="me-1.5 h-3.5 w-3.5" />
              {t("attachments.add")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || loading}
            onClick={() => void reload()}
          >
            <RefreshCw className={`me-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {t("attachments.refresh")}
          </Button>
          {transfer ? (
            <>
              <span className="text-xs text-muted-foreground" role="status">
                {transfer.label}
              </span>
              {transfer.abort ? (
                <Button size="sm" variant="ghost" onClick={() => transfer.abort?.abort()}>
                  {t("common.cancel")}
                </Button>
              ) : null}
            </>
          ) : null}
          <input
            ref={addInputRef}
            type="file"
            multiple
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              addFiles(files);
            }}
          />
          <input
            ref={replaceInputRef}
            type="file"
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              const target = replaceTargetRef.current;
              replaceTargetRef.current = null;
              if (file && target) replaceFile(target, file);
            }}
          />
        </div>

        {statuses.length ? (
          <ul className="space-y-1 text-xs" aria-live="polite">
            {statuses.map((status, i) => (
              <li
                key={i}
                className={status.kind === "error" ? "text-destructive" : "text-muted-foreground"}
              >
                {status.text}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="max-h-80 overflow-y-auto rounded-md border">
          {loadError ? (
            <p className="p-3 text-sm text-destructive">{loadError}</p>
          ) : attachments === null ? (
            <p className="p-3 text-sm text-muted-foreground">{t("attachments.loading")}</p>
          ) : attachments.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">{t("attachments.empty")}</p>
          ) : (
            <ul className="divide-y">
              {attachments.map((attachment) => (
                <li key={attachment.id} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium" title={attachment.name}>
                      {attachment.name}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {attachment.contentType} ·{" "}
                      {formatAttachmentSize(attachment.size, i18n.language)}
                    </div>
                  </div>
                  {pendingDelete === attachment.id ? (
                    <>
                      <span className="text-xs">{t("attachments.confirmDelete")}</span>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => removeAttachment(attachment)}
                      >
                        {t("attachments.delete")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setPendingDelete(null)}>
                        {t("common.cancel")}
                      </Button>
                    </>
                  ) : (
                    <>
                      {isPreviewableAttachment(attachment.contentType) ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          disabled={busy}
                          title={t("attachments.preview")}
                          aria-label={t("attachments.previewAria", { name: attachment.name })}
                          onClick={() => showPreview(attachment)}
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        disabled={busy}
                        title={t("attachments.download")}
                        aria-label={t("attachments.downloadAria", { name: attachment.name })}
                        onClick={() => download(attachment)}
                      >
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                      {support.update ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          disabled={busy}
                          title={t("attachments.replace")}
                          aria-label={t("attachments.replaceAria", { name: attachment.name })}
                          onClick={() => {
                            replaceTargetRef.current = attachment;
                            replaceInputRef.current?.click();
                          }}
                        >
                          <Replace className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                      {support.delete ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-destructive"
                          disabled={busy}
                          title={t("attachments.delete")}
                          aria-label={t("attachments.deleteAria", { name: attachment.name })}
                          onClick={() => setPendingDelete(attachment.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {preview ? (
          <figure className="space-y-1">
            <img
              src={preview.url}
              alt={preview.name}
              className="mx-auto max-h-72 max-w-full rounded-md border object-contain"
            />
            <figcaption className="text-center text-xs text-muted-foreground">
              {preview.name}
            </figcaption>
          </figure>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
