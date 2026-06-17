/**
 * "Saved services" box rendered atop each web-service source in the Add Data
 * dialog. Lets users save the current form to a cross-project library, reload a
 * saved (or built-in) service into the form, delete their own entries, and
 * import/export the library as JSON (issue #417).
 *
 * Persistence and validation live in `service-library.ts`; this component owns
 * only the dialog-scoped UI state.
 */

import { Button, Input, Label, Select } from "@geolibre/ui";
import { Bookmark, Download, Save, Trash2, Upload, X } from "lucide-react";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { saveTextFileWithFallback } from "../../../lib/tauri-io";
import {
  createServiceEntry,
  listServices,
  mergeImportedServices,
  parseImportedServices,
  readUserServices,
  removeServiceEntry,
  serializeUserServices,
  serviceCategories,
  type ServiceFields,
  type ServiceLibraryEntry,
  type ServiceLibraryKind,
  UNCATEGORIZED_LABEL,
  upsertServiceEntry,
  writeUserServices,
} from "./service-library";

/** Upper bound for an imported library file; a real one is only a few KB. */
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

interface ServiceLibrarySectionProps {
  /** Which web-service source this section belongs to. */
  kind: ServiceLibraryKind;
  /** Current layer name, offered as the default when saving. */
  layerName: string;
  /** Serialises the current form into a field bag for saving. */
  getFields: () => ServiceFields;
  /** Repopulates the form from a chosen entry. */
  onApply: (entry: ServiceLibraryEntry) => void;
}

interface CategoryGroup {
  label: string;
  entries: ServiceLibraryEntry[];
}

/** Groups entries by category for the picker, with uncategorised entries last. */
function groupByCategory(entries: ServiceLibraryEntry[]): CategoryGroup[] {
  const groups = new Map<string, ServiceLibraryEntry[]>();
  for (const entry of entries) {
    const label = entry.category || UNCATEGORIZED_LABEL;
    const group = groups.get(label);
    if (group) group.push(entry);
    else groups.set(label, [entry]);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => {
      if (a === UNCATEGORIZED_LABEL) return 1;
      if (b === UNCATEGORIZED_LABEL) return -1;
      return a.localeCompare(b);
    })
    .map(([label, entries]) => ({ label, entries }));
}

export function ServiceLibrarySection({
  kind,
  layerName,
  getFields,
  onApply,
}: ServiceLibrarySectionProps) {
  const [userEntries, setUserEntries] = useState<ServiceLibraryEntry[]>(() =>
    readUserServices(),
  );
  const [selectedId, setSelectedId] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveCategory, setSaveCategory] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const categoryListId = `service-categories-${kind}`;

  const entries = useMemo(
    () => listServices(kind, userEntries),
    [kind, userEntries],
  );
  const groups = useMemo(() => groupByCategory(entries), [entries]);
  const categories = useMemo(
    () => serviceCategories(entries),
    [entries],
  );
  const selectedEntry = entries.find((entry) => entry.id === selectedId) ?? null;
  const canDeleteSelected = Boolean(selectedEntry && !selectedEntry.builtin);

  const persist = (next: ServiceLibraryEntry[]) => {
    setUserEntries(next);
    writeUserServices(next);
  };

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setError(null);
    setNotice(null);
    const entry = entries.find((candidate) => candidate.id === id);
    if (entry) onApply(entry);
  };

  const openSaveForm = () => {
    setSaveName(layerName.trim() || selectedEntry?.name || "");
    setSaveCategory(selectedEntry?.category ?? "");
    setError(null);
    setNotice(null);
    setIsSaving(true);
  };

  const handleSave = () => {
    const name = saveName.trim();
    if (!name) {
      setError("Enter a name for the saved service.");
      return;
    }
    // Update the selected entry in place when it's a user-owned service;
    // otherwise (nothing or a built-in selected) mint a new one.
    const entry = createServiceEntry({
      id:
        selectedEntry && !selectedEntry.builtin ? selectedEntry.id : undefined,
      name,
      category: saveCategory,
      kind,
      fields: getFields(),
    });
    persist(upsertServiceEntry(userEntries, entry));
    setSelectedId(entry.id);
    setIsSaving(false);
    setError(null);
    setNotice(`Saved "${name}" to the service library.`);
  };

  // The save-form inputs live inside AddDataSourceForm's <form>, so a bare
  // Enter would submit it (adding a layer). Intercept Enter to save instead;
  // forms can't be nested, so this is the keyboard path for the save form.
  const handleSaveFieldKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleSave();
    }
  };

  const handleDelete = () => {
    if (!selectedEntry || selectedEntry.builtin) return;
    persist(removeServiceEntry(userEntries, selectedEntry.id));
    setSelectedId("");
    setError(null);
    setNotice(`Removed "${selectedEntry.name}".`);
  };

  const handleExport = async () => {
    setError(null);
    setNotice(null);
    try {
      await saveTextFileWithFallback(serializeUserServices(userEntries), {
        defaultName: "geolibre-service-library.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
        browserTypes: [
          { description: "JSON", accept: { "application/json": [".json"] } },
        ],
        mimeType: "application/json",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not export library.");
    }
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setNotice(null);
    // A library JSON is tiny; guard against accidentally reading a huge file
    // fully into memory (the entry cap only applies after parsing).
    if (file.size > MAX_IMPORT_BYTES) {
      setError("File is too large to import (max 5 MB).");
      return;
    }
    try {
      const imported = parseImportedServices(await file.text());
      if (imported.length === 0) {
        setError("No valid services found in that file.");
        return;
      }
      // Merge against the freshly-persisted list rather than the closed-over
      // `userEntries`, which may be stale after the `await file.text()` if the
      // user saved/deleted in the meantime.
      // mergeImportedServices caps the combined list at MAX_SAVED_SERVICES, so
      // report the count actually kept rather than the count in the file.
      const current = readUserServices();
      const next = mergeImportedServices(current, imported);
      persist(next);
      const before = current.length;
      const added = next.length - before;
      const dropped = imported.length - added;
      setNotice(
        `Imported ${added} service${added === 1 ? "" : "s"}${
          dropped > 0 ? ` (${dropped} skipped — library full)` : ""
        }.`,
      );
    } catch {
      setError("Could not read that file as a service library.");
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Bookmark className="h-3.5 w-3.5" />
          Saved services
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={openSaveForm}
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            Save current
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Import library from JSON"
            title="Import library from JSON"
            onClick={() => importInputRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Export library to JSON"
            title="Export library to JSON"
            disabled={userEntries.length === 0}
            onClick={handleExport}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {entries.length > 0 ? (
        <div className="flex items-center gap-2">
          <Select
            aria-label="Load a saved service"
            className="flex-1"
            value={selectedId}
            onChange={(event) => handleSelect(event.target.value)}
          >
            <option value="">Load a saved service…</option>
            {groups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.entries.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                    {entry.builtin ? " (built-in)" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Delete saved service"
            title="Delete saved service"
            disabled={!canDeleteSelected}
            onClick={handleDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No saved services yet — fill in the form and choose “Save current”.
        </p>
      )}

      {isSaving ? (
        <div className="space-y-2 rounded-md border border-border/60 bg-background p-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`service-save-name-${kind}`}>Name</Label>
              <Input
                id={`service-save-name-${kind}`}
                value={saveName}
                onChange={(event) => setSaveName(event.target.value)}
                onKeyDown={handleSaveFieldKeyDown}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`service-save-category-${kind}`}>Category</Label>
              <Input
                id={`service-save-category-${kind}`}
                list={categoryListId}
                placeholder="Optional (e.g. country, theme)"
                value={saveCategory}
                onChange={(event) => setSaveCategory(event.target.value)}
                onKeyDown={handleSaveFieldKeyDown}
              />
              <datalist id={categoryListId}>
                {categories.map((category) => (
                  <option key={category} value={category} />
                ))}
              </datalist>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setIsSaving(false)}
            >
              <X className="mr-1.5 h-3.5 w-3.5" />
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={handleSave}>
              <Save className="mr-1.5 h-3.5 w-3.5" />
              Save
            </Button>
          </div>
        </div>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {notice ? (
        <p className="text-xs text-muted-foreground">{notice}</p>
      ) : null}

      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          void handleImportFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    </div>
  );
}
