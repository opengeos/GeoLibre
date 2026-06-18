import {
  BLANK_BASEMAP,
  createDefaultMapView,
  getProtomapsStyleUrl,
  OPENFREEMAP_BASEMAPS,
  PROTOMAPS_BASEMAPS,
  useAppStore,
  type MapViewState,
} from "@geolibre/core";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@geolibre/ui";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";

const DEFAULT_BASEMAP_ID = "liberty";
const CUSTOM_BASEMAP_ID = "custom";
const BLANK_BASEMAP_ID = "blank";
const DEFAULT_PROJECT_NAME = "Untitled Project";

const THREE_D_MAP_VIEW: MapViewState = {
  center: [-0.114, 51.506],
  zoom: 14.2,
  bearing: 55.2,
  pitch: 60,
};

interface PresetBasemap {
  id: string;
  name: string;
  styleUrl: string;
}

/**
 * Resolves the selectable Protomaps basemaps for the current runtime
 * environment. Returns an empty list when no `VITE_PROTOMAPS_API_KEY` is
 * configured (build-time or via Settings → Environment variables), in which
 * case the Protomaps section is hidden.
 */
function resolveProtomapsPresets(): PresetBasemap[] {
  return PROTOMAPS_BASEMAPS.flatMap((basemap) => {
    const styleUrl = getProtomapsStyleUrl(basemap.flavor);
    return styleUrl ? [{ id: basemap.id, name: basemap.name, styleUrl }] : [];
  });
}

type BasemapChoice = string;

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaveCurrentProject: () => Promise<boolean>;
  onProjectCreated?: () => void;
}

export function NewProjectDialog({
  open,
  onOpenChange,
  onSaveCurrentProject,
  onProjectCreated,
}: NewProjectDialogProps) {
  const newProject = useAppStore((s) => s.newProject);
  const isDirty = useAppStore((s) => s.isDirty);
  const [selectedBasemapId, setSelectedBasemapId] =
    useState<BasemapChoice>(DEFAULT_BASEMAP_ID);
  const [projectName, setProjectName] = useState(DEFAULT_PROJECT_NAME);
  const [customUrl, setCustomUrl] = useState("");
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const customStyleUrl = customUrl.trim();
  const isCustomSelected = selectedBasemapId === CUSTOM_BASEMAP_ID;
  const isBlankSelected = selectedBasemapId === BLANK_BASEMAP_ID;
  // Protomaps styles need an API key (VITE_PROTOMAPS_API_KEY). It can come from
  // the build or from Settings → Environment variables, so re-resolve when the
  // dialog opens and whenever the runtime env changes; an absent key hides the
  // section.
  const [protomapsPresets, setProtomapsPresets] = useState<PresetBasemap[]>(
    resolveProtomapsPresets,
  );
  useEffect(() => {
    const refresh = () => setProtomapsPresets(resolveProtomapsPresets());
    refresh();
    window.addEventListener("geolibre:runtime-env-change", refresh);
    return () =>
      window.removeEventListener("geolibre:runtime-env-change", refresh);
  }, [open]);
  const selectedPreset = useMemo<PresetBasemap | undefined>(
    () =>
      [...OPENFREEMAP_BASEMAPS, ...protomapsPresets].find(
        (basemap) => basemap.id === selectedBasemapId,
      ),
    [protomapsPresets, selectedBasemapId],
  );
  const isCustomUrlValid = useMemo(() => {
    if (!customStyleUrl) return false;
    try {
      const url = new URL(customStyleUrl);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, [customStyleUrl]);
  const canCreate = isCustomSelected
    ? isCustomUrlValid
    : isBlankSelected || Boolean(selectedPreset);

  const resetForm = () => {
    setSelectedBasemapId(DEFAULT_BASEMAP_ID);
    setProjectName(DEFAULT_PROJECT_NAME);
    setCustomUrl("");
    setShowSavePrompt(false);
    setIsSaving(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) resetForm();
  };

  const createProject = () => {
    if (!canCreate) return;

    const basemapStyleUrl = isCustomSelected
      ? customStyleUrl
      : isBlankSelected
        ? BLANK_BASEMAP
        : selectedPreset?.styleUrl;
    if (basemapStyleUrl == null) return;

    newProject({
      name: projectName.trim() || DEFAULT_PROJECT_NAME,
      basemapStyleUrl,
      mapView:
        selectedBasemapId === "liberty-3d"
          ? THREE_D_MAP_VIEW
          : createDefaultMapView(),
    });
    onProjectCreated?.();
    onOpenChange(false);
    resetForm();
  };

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate) return;

    if (isDirty) {
      setShowSavePrompt(true);
      return;
    }

    createProject();
  };

  const handleSaveThenCreate = async () => {
    setIsSaving(true);
    try {
      const saved = await onSaveCurrentProject();
      if (saved) createProject();
    } catch (error) {
      console.error("Failed to save project", error);
    } finally {
      setIsSaving(false);
    }
  };

  const renderBasemapButton = (id: string, name: string) => (
    <button
      key={id}
      type="button"
      aria-pressed={selectedBasemapId === id}
      className={cn(
        "h-10 rounded-md border px-3 text-sm font-medium transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        selectedBasemapId === id
          ? "border-primary bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
          : "border-input bg-background",
      )}
      onClick={() => setSelectedBasemapId(id)}
    >
      {name}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl">
        {showSavePrompt ? (
          <>
            <DialogHeader>
              <DialogTitle>Save current project?</DialogTitle>
              <DialogDescription>
                The current project has unsaved changes. Save them before
                creating a new map?
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={isSaving}
                onClick={() => setShowSavePrompt(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={isSaving}
                onClick={createProject}
              >
                Do not save
              </Button>
              <Button
                type="button"
                disabled={isSaving}
                onClick={handleSaveThenCreate}
              >
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New map</DialogTitle>
              <DialogDescription>
                Choose an OpenFreeMap or Protomaps basemap, a blank background,
                or a MapLibre style URL.
              </DialogDescription>
            </DialogHeader>
            <form className="space-y-5" onSubmit={handleCreate}>
              <div className="space-y-2">
                <Label htmlFor="new-project-name">Project name</Label>
                <Input
                  id="new-project-name"
                  autoFocus
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                />
              </div>

              <div className="space-y-4">
                <Label>Basemap</Label>

                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    OpenFreeMap
                  </p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {OPENFREEMAP_BASEMAPS.map((basemap) =>
                      renderBasemapButton(basemap.id, basemap.name),
                    )}
                  </div>
                </div>

                {protomapsPresets.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      Protomaps
                    </p>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {protomapsPresets.map((basemap) =>
                        renderBasemapButton(basemap.id, basemap.name),
                      )}
                    </div>
                  </div>
                ) : null}

                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Other
                  </p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {renderBasemapButton(BLANK_BASEMAP_ID, "Blank")}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="custom-basemap-url">Custom URL</Label>
                <Input
                  id="custom-basemap-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://example.com/style.json"
                  value={customUrl}
                  onChange={(event) => {
                    setCustomUrl(event.target.value);
                    setSelectedBasemapId(CUSTOM_BASEMAP_ID);
                  }}
                />
                {isCustomSelected && customStyleUrl && !isCustomUrlValid ? (
                  <p className="text-xs text-destructive">
                    Enter a valid HTTP or HTTPS style URL.
                  </p>
                ) : null}
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={!canCreate}>
                  Create
                </Button>
              </div>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
