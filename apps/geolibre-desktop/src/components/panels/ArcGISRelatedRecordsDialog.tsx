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
import type { GeoLibreLayer } from "@geolibre/core";
import {
  addArcGISRelatedRecord,
  arcGISRelatedAttachmentSupport,
  arcGISRelatedEditSupport,
  arcGISRelatedFields,
  arcGISRelatedNewRecordDefaults,
  arcGISRelatedParentKey,
  deleteArcGISRelatedRecord,
  fetchArcGISRelatedTableInfo,
  LocalizedError,
  queryArcGISRelatedRecords,
  updateArcGISRelatedRecord,
  type ArcGISRelatedField,
  type ArcGISRelatedRecord,
  type ArcGISRelatedTableInfo,
  type ArcGISRelationship,
} from "@geolibre/plugins";
import type { Feature } from "geojson";
import { Network, Paperclip, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  relatedDisplayText,
  relatedInputText,
  relatedInputValue,
  relatedValueOutsideDomain,
} from "../../lib/arcgis-related-values";
import { ArcGISAttachmentsDialog } from "./ArcGISAttachmentsDialog";

interface ArcGISRelatedRecordsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  layer: GeoLibreLayer;
  /** The selected parent feature. */
  parent: Feature;
  /** The parent's service object ID. */
  objectId: number;
  relationships: ArcGISRelationship[];
}

interface Status {
  kind: "success" | "error";
  text: string;
}

/** The row being edited, or a new one; `draft` holds only the fields the user changed. */
type Editing =
  | { mode: "add"; draft: Record<string, string> }
  | { mode: "edit"; record: ArcGISRelatedRecord; draft: Record<string, string> };

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A stored value read case-insensitively, as ArcGIS field names are. */
function valueOf(attributes: Record<string, unknown>, name: string): unknown {
  if (Object.hasOwn(attributes, name)) return attributes[name];
  const lower = name.toLowerCase();
  const key = Object.keys(attributes).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : attributes[key];
}

/**
 * The rows a published ArcGIS relationship links to one record: browse them,
 * and where the service allows, add, edit and delete them. Every write goes to
 * the related table at once and the rows are read back afterwards, so what is
 * shown is the service's state.
 */
export function ArcGISRelatedRecordsDialog({
  open,
  onOpenChange,
  layer,
  parent,
  objectId,
  relationships,
}: ArcGISRelatedRecordsDialogProps) {
  const { t, i18n } = useTranslation();
  const [relationshipId, setRelationshipId] = useState(relationships[0]?.id);
  const relationship =
    relationships.find((entry) => entry.id === relationshipId) ?? relationships[0];
  const [related, setRelated] = useState<ArcGISRelatedTableInfo | null>(null);
  const [records, setRecords] = useState<ArcGISRelatedRecord[] | null>(null);
  const [complete, setComplete] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [transfer, setTransfer] = useState<{ label: string; abort: AbortController | null } | null>(
    null,
  );
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  // The related row whose attachments are shown, by its service object ID.
  const [attachmentsFor, setAttachmentsFor] = useState<number | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  // The parent and relationship a request was made for; a reply for another is stale.
  const layerId = layer.id;
  const viewKey = `${layerId}:${objectId}:${relationship?.id}`;
  const viewKeyRef = useRef(viewKey);
  viewKeyRef.current = viewKey;

  useEffect(() => {
    if (!relationships.some((entry) => entry.id === relationshipId))
      setRelationshipId(relationships[0]?.id);
  }, [relationships, relationshipId]);

  // Keyed by IDs: the relationship objects are rebuilt whenever the layer
  // changes (viewport loading, for one), which must not restart the dialog.
  const relId = relationship?.id;
  const relatedTableId = relationship?.relatedTableId;
  const reload = useCallback(
    async (keepRelated: ArcGISRelatedTableInfo | null) => {
      if (relId === undefined || relatedTableId === undefined) return;
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;
      const key = `${layerId}:${objectId}:${relId}`;
      setLoading(true);
      setLoadError(null);
      try {
        const info =
          keepRelated ??
          (await fetchArcGISRelatedTableInfo(layerId, { relatedTableId }, controller.signal));
        if (viewKeyRef.current !== key || controller.signal.aborted) return;
        setRelated(info);
        const result = await queryArcGISRelatedRecords(
          layerId,
          objectId,
          { id: relId },
          info,
          controller.signal,
        );
        if (viewKeyRef.current !== key || controller.signal.aborted) return;
        setRecords(result.records);
        setComplete(result.complete);
      } catch (error) {
        if (isAbort(error) || viewKeyRef.current !== key) return;
        setRecords(null);
        setLoadError(errorText(error));
      } finally {
        if (loadAbortRef.current === controller) {
          loadAbortRef.current = null;
          setLoading(false);
        }
      }
    },
    [layerId, objectId, relId, relatedTableId],
  );
  const relatedRef = useRef(related);
  relatedRef.current = related;
  // A write's read-back targets the current view, not the one it started on.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  // A new parent, relationship, or reopening starts from the service's state.
  useEffect(() => {
    if (!open) return;
    setRelated(null);
    setRecords(null);
    setComplete(true);
    setStatuses([]);
    setEditing(null);
    setPendingDelete(null);
    setAttachmentsFor(null);
    void reload(null);
    return () => loadAbortRef.current?.abort();
  }, [open, reload]);

  const support = useMemo(
    () =>
      related && relationship
        ? arcGISRelatedEditSupport(layer, relationship, related)
        : { add: false, update: false, delete: false },
    [layer, relationship, related],
  );
  const parentKey = relationship ? arcGISRelatedParentKey(layer, relationship, parent) : undefined;
  const listFields = useMemo(
    () => (related ? arcGISRelatedFields(related, support, null) : []),
    [related, support],
  );
  const oneToOneTaken = relationship?.cardinality === "oneToOne" && (records?.length ?? 0) > 0;
  const canAdd = support.add && parentKey !== undefined && !oneToOneTaken;
  const canWrite = support.add || support.update || support.delete;
  // Attachments of related rows follow the related table's own metadata.
  const attachmentSupport = useMemo(
    () => (related ? arcGISRelatedAttachmentSupport(layer, related) : undefined),
    [layer, related],
  );
  const showActions = support.update || support.delete || Boolean(attachmentSupport?.list);

  /** Run one write at a time, then read the rows back. */
  const runWrite = async (
    label: string,
    work: (signal: AbortSignal) => Promise<Status[]>,
    { cancellable = true } = {},
  ) => {
    const abort = new AbortController();
    // A write that finishes after the parent or relationship changed must not
    // report into the new view; that view starts from the service's state.
    const writeViewKey = viewKey;
    setTransfer({ label, abort: cancellable ? abort : null });
    let ok = false;
    try {
      const next = await work(abort.signal);
      if (viewKeyRef.current !== writeViewKey) return false;
      setStatuses(next);
      ok = true;
    } catch (error) {
      if (viewKeyRef.current !== writeViewKey) return false;
      if (!isAbort(error)) setStatuses([{ kind: "error", text: errorText(error) }]);
      // An unknown outcome may already be saved: close the editor so the same
      // insert cannot be sent again before the rows are read back.
      if (error instanceof LocalizedError && error.key.endsWith(".relatedUnconfirmed"))
        setEditing(null);
    } finally {
      setTransfer(null);
      void reloadRef.current(relatedRef.current);
    }
    return ok;
  };

  const editValues = (state: Editing, fields: ArcGISRelatedField[]) => {
    const values: Record<string, unknown> = {};
    for (const field of fields) {
      if (!field.editable || !Object.hasOwn(state.draft, field.name)) continue;
      values[field.name] = relatedInputValue(field, state.draft[field.name]);
    }
    return values;
  };

  const save = async (state: Editing) => {
    if (!related || !relationship) return;
    const base =
      state.mode === "edit"
        ? state.record.attributes
        : arcGISRelatedNewRecordDefaults(related, support);
    const fields = arcGISRelatedFields(related, support, base);
    const values = editValues(state, fields);
    if (state.mode === "add") {
      if (parentKey === undefined) return;
      const ok = await runWrite(t("relatedRecords.saving"), async (signal) => {
        const id = await addArcGISRelatedRecord(
          layer.id,
          relationship,
          related,
          support,
          parentKey,
          values,
          signal,
        );
        return [{ kind: "success", text: t("relatedRecords.added", { id }) }];
      });
      if (ok) setEditing(null);
      return;
    }
    const ok = await runWrite(t("relatedRecords.saving"), async (signal) => {
      const sent = await updateArcGISRelatedRecord(
        layer.id,
        relationship,
        related,
        support,
        state.record,
        values,
        signal,
      );
      return [
        {
          kind: "success",
          text: sent
            ? t("relatedRecords.updated", { id: state.record.objectId })
            : t("relatedRecords.unchanged"),
        },
      ];
    });
    if (ok) setEditing(null);
  };

  const remove = (record: ArcGISRelatedRecord) => {
    if (!relationship) return;
    setPendingDelete(null);
    void runWrite(
      t("relatedRecords.deleting", { id: record.objectId }),
      async () => {
        await deleteArcGISRelatedRecord(layer.id, relationship, support, record.objectId);
        return [{ kind: "success", text: t("relatedRecords.deleted", { id: record.objectId }) }];
      },
      { cancellable: false },
    );
  };

  const busy = transfer !== null;
  const tableName = related?.name?.trim() || relationship?.name || "";

  const renderEditor = (state: Editing) => {
    if (!related) return null;
    // A new row shows the table's creation defaults, which saving applies too.
    const base =
      state.mode === "edit"
        ? state.record.attributes
        : arcGISRelatedNewRecordDefaults(related, support);
    // Domains follow the row's own type or subtype, including an unsaved change.
    const candidate = { ...base };
    const preliminary = arcGISRelatedFields(related, support, base);
    Object.assign(candidate, editValues(state, preliminary));
    // A new row has no service-assigned values yet, so those fields are left out.
    const fields = arcGISRelatedFields(related, support, candidate).filter(
      (field) => state.mode === "edit" || field.editable || field.managedKey,
    );
    const setDraft = (name: string, text: string) =>
      setEditing({ ...state, draft: { ...state.draft, [name]: text } });
    return (
      <form
        // The save check validates only the fields that changed; native
        // constraint checks would block a row holding a historical value.
        noValidate
        className="space-y-3 rounded-md border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save(state);
        }}
      >
        <div className="text-sm font-medium">
          {state.mode === "add"
            ? t("relatedRecords.newRecord", { table: tableName })
            : t("relatedRecords.editRecord", { id: state.record.objectId })}
        </div>
        <div className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto pe-1 sm:grid-cols-2">
          {fields.map((field) => {
            const id = `related-field-${field.name}`;
            const stored = field.managedKey
              ? state.mode === "add"
                ? parentKey
                : valueOf(base, field.name)
              : valueOf(base, field.name);
            const touched = Object.hasOwn(state.draft, field.name);
            const text = touched ? state.draft[field.name] : relatedInputText(field, stored);
            const current = touched ? relatedInputValue(field, text) : stored;
            const invalid = relatedValueOutsideDomain(field, current);
            if (!field.editable) {
              return (
                <div key={field.name} className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{field.label}</Label>
                  <div className="truncate text-sm" title={stored == null ? "" : String(stored)}>
                    {relatedDisplayText(field, stored, i18n.language) || " "}
                  </div>
                  {field.managedKey ? (
                    <div className="text-xs text-muted-foreground">
                      {t("relatedRecords.managedKey")}
                    </div>
                  ) : null}
                </div>
              );
            }
            return (
              <div key={field.name} className="space-y-1">
                <Label htmlFor={id} className="text-xs">
                  {field.label}
                  {field.required ? " *" : ""}
                </Label>
                {field.codedValues ? (
                  <Select
                    id={id}
                    value={text}
                    aria-invalid={invalid || undefined}
                    onChange={(event) => setDraft(field.name, event.target.value)}
                  >
                    {!field.required || text === "" ? (
                      <option value="">{t("relatedRecords.noValue")}</option>
                    ) : null}
                    {invalid && current != null ? (
                      <option value={text}>
                        {t("relatedRecords.outsideDomainOption", { value: text })}
                      </option>
                    ) : null}
                    {field.codedValues.map((entry) => (
                      <option key={String(entry.code)} value={String(entry.code)}>
                        {entry.name || String(entry.code)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id={id}
                    type={
                      field.kind === "date"
                        ? "datetime-local"
                        : field.kind === "integer" || field.kind === "number"
                          ? "number"
                          : "text"
                    }
                    value={text}
                    min={field.min}
                    max={field.max}
                    step={
                      field.kind === "integer" ? 1 : field.kind === "number" ? "any" : undefined
                    }
                    maxLength={field.maxLength}
                    aria-invalid={invalid || undefined}
                    onChange={(event) => setDraft(field.name, event.target.value)}
                  />
                )}
                {invalid ? (
                  <div className="text-xs text-destructive">
                    {touched
                      ? t("relatedRecords.outsideDomainEntered")
                      : t("relatedRecords.outsideDomain")}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(null)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {t("relatedRecords.save")}
          </Button>
        </div>
      </form>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Network className="h-4 w-4" />
            {t("relatedRecords.title")}
          </DialogTitle>
          <DialogDescription>
            {t("relatedRecords.description", { objectId, layer: layer.name })}
            {canWrite ? ` ${t("relatedRecords.savesDirectly")}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-2">
          {relationships.length > 1 ? (
            <div className="min-w-48 space-y-1">
              <Label htmlFor="related-relationship" className="text-xs">
                {t("relatedRecords.relationship")}
              </Label>
              <Select
                id="related-relationship"
                value={String(relationship?.id ?? "")}
                disabled={busy}
                onChange={(event) => setRelationshipId(Number(event.target.value))}
              >
                {relationships.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          {canAdd ? (
            <Button
              size="sm"
              disabled={busy || editing !== null || records === null}
              onClick={() => setEditing({ mode: "add", draft: {} })}
            >
              <Plus className="me-1.5 h-3.5 w-3.5" />
              {t("relatedRecords.add")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || loading}
            onClick={() => {
              setStatuses([]);
              void reload(related);
            }}
          >
            <RefreshCw className={`me-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {t("relatedRecords.refresh")}
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
        </div>

        {related ? (
          <p className="text-xs text-muted-foreground">
            {t("relatedRecords.relatedTable", { table: tableName })}
            {support.add && parentKey === undefined
              ? ` ${t("relatedRecords.parentKeyMissing", { field: relationship?.keyField ?? "" })}`
              : ""}
          </p>
        ) : null}

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

        {!complete ? (
          <p className="rounded-md border border-destructive/50 p-2 text-xs text-destructive">
            {t("relatedRecords.incomplete", { count: records?.length ?? 0 })}
          </p>
        ) : null}

        {editing ? renderEditor(editing) : null}

        <div className="max-h-80 overflow-auto rounded-md border">
          {loadError ? (
            <p className="p-3 text-sm text-destructive">{loadError}</p>
          ) : records === null ? (
            <p className="p-3 text-sm text-muted-foreground">{t("relatedRecords.loading")}</p>
          ) : records.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">{t("relatedRecords.empty")}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  {listFields.map((field) => (
                    <th key={field.name} className="whitespace-nowrap px-2 py-1.5 text-start">
                      {field.label}
                    </th>
                  ))}
                  {showActions ? (
                    <th className="sticky end-0 bg-muted px-2 py-1.5">
                      <span className="sr-only">{t("relatedRecords.actions")}</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y">
                {records.map((record) => {
                  const rowFields = arcGISRelatedFields(related!, support, record.attributes);
                  return (
                    <tr key={record.objectId}>
                      {rowFields.map((field) => {
                        const value = valueOf(record.attributes, field.name);
                        const outside = relatedValueOutsideDomain(field, value);
                        return (
                          <td
                            key={field.name}
                            className={`max-w-48 truncate px-2 py-1.5 ${outside ? "text-destructive" : ""}`}
                            title={
                              outside
                                ? t("relatedRecords.outsideDomainTitle", { value: String(value) })
                                : value == null
                                  ? undefined
                                  : String(value)
                            }
                          >
                            {relatedDisplayText(field, value, i18n.language)}
                          </td>
                        );
                      })}
                      {showActions ? (
                        // Kept in view while wide tables scroll sideways.
                        <td className="sticky end-0 whitespace-nowrap bg-background px-2 py-1 text-end">
                          {pendingDelete === record.objectId ? (
                            <span className="inline-flex items-center gap-1">
                              <span>{t("relatedRecords.confirmDelete")}</span>
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={busy}
                                onClick={() => remove(record)}
                              >
                                {t("relatedRecords.delete")}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setPendingDelete(null)}
                              >
                                {t("common.cancel")}
                              </Button>
                            </span>
                          ) : (
                            <>
                              {attachmentSupport?.list ? (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7"
                                  disabled={busy}
                                  title={t("relatedRecords.attachments")}
                                  aria-label={t("relatedRecords.attachmentsAria", {
                                    id: record.objectId,
                                  })}
                                  onClick={() => setAttachmentsFor(record.objectId)}
                                >
                                  <Paperclip className="h-3.5 w-3.5" />
                                </Button>
                              ) : null}
                              {support.update ? (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7"
                                  disabled={busy || editing !== null}
                                  title={t("relatedRecords.edit")}
                                  aria-label={t("relatedRecords.editAria", {
                                    id: record.objectId,
                                  })}
                                  onClick={() => setEditing({ mode: "edit", record, draft: {} })}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                              ) : null}
                              {support.delete ? (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7 text-destructive"
                                  disabled={busy || editing !== null}
                                  title={t("relatedRecords.delete")}
                                  aria-label={t("relatedRecords.deleteAria", {
                                    id: record.objectId,
                                  })}
                                  onClick={() => setPendingDelete(record.objectId)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              ) : null}
                            </>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
      {attachmentSupport && attachmentsFor !== null && relatedTableId !== undefined ? (
        <ArcGISAttachmentsDialog
          open
          onOpenChange={(next) => {
            if (!next) setAttachmentsFor(null);
          }}
          source={{ layerId, tableId: relatedTableId }}
          layerName={tableName}
          objectId={attachmentsFor}
          support={attachmentSupport}
        />
      ) : null}
    </Dialog>
  );
}
