import {
  BLANK_BASEMAP,
  createDefaultMapView,
  OPENFREEMAP_BASEMAPS,
  useAppStore,
  type MapViewState,
} from "@geolibre/core";
import {
  Button,
  type ButtonProps,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
} from "@geolibre/ui";
import { FilePlus2 } from "lucide-react";
import type { FormEvent } from "react";
import { useMemo, useState } from "react";

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

type PresetBasemapId = (typeof OPENFREEMAP_BASEMAPS)[number]["id"];
type BasemapChoice =
  | PresetBasemapId
  | typeof CUSTOM_BASEMAP_ID
  | typeof BLANK_BASEMAP_ID;

interface NewProjectDialogProps {
  buttonClassName?: string;
  buttonSize?: ButtonProps["size"];
  iconClassName?: string;
  showLabels?: boolean;
  onSaveCurrentProject: () => Promise<boolean>;
}

export function NewProjectDialog({
  buttonClassName,
  buttonSize = "sm",
  iconClassName,
  showLabels = true,
  onSaveCurrentProject,
}: NewProjectDialogProps) {
  const newProject = useAppStore((s) => s.newProject);
  const isDirty = useAppStore((s) => s.isDirty);
  const [open, setOpen] = useState(false);
  const [selectedBasemapId, setSelectedBasemapId] =
    useState<BasemapChoice>(DEFAULT_BASEMAP_ID);
  const [projectName, setProjectName] = useState(DEFAULT_PROJECT_NAME);
  const [customUrl, setCustomUrl] = useState("");
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const customStyleUrl = customUrl.trim();
  const isCustomSelected = selectedBasemapId === CUSTOM_BASEMAP_ID;
  const isBlankSelected = selectedBasemapId === BLANK_BASEMAP_ID;
  const selectedPreset = OPENFREEMAP_BASEMAPS.find(
    (basemap) => basemap.id === selectedBasemapId,
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
    setOpen(nextOpen);
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
    setOpen(false);
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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          className={buttonClassName}
          variant="ghost"
          size={buttonSize}
          aria-label="New project"
        >
          <FilePlus2 className={iconClassName ?? "h-3.5 w-3.5 sm:mr-1"} />
          {showLabels ? <span className="hidden sm:inline">New</span> : null}
        </Button>
      </DialogTrigger>
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
                Choose a blank background, an OpenFreeMap basemap, or a
                MapLibre style URL.
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

              <div className="space-y-2">
                <Label>Basemap</Label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {OPENFREEMAP_BASEMAPS.map((basemap) => (
                    <button
                      key={basemap.id}
                      type="button"
                      aria-pressed={selectedBasemapId === basemap.id}
                      className={cn(
                        "h-10 rounded-md border px-3 text-sm font-medium transition-colors",
                        "hover:bg-accent hover:text-accent-foreground",
                        selectedBasemapId === basemap.id
                          ? "border-primary bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                          : "border-input bg-background",
                      )}
                      onClick={() => setSelectedBasemapId(basemap.id)}
                    >
                      {basemap.name}
                    </button>
                  ))}
                  <button
                    type="button"
                    aria-pressed={isBlankSelected}
                    className={cn(
                      "h-10 rounded-md border px-3 text-sm font-medium transition-colors",
                      "hover:bg-accent hover:text-accent-foreground",
                      isBlankSelected
                        ? "border-primary bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                        : "border-input bg-background",
                    )}
                    onClick={() => setSelectedBasemapId(BLANK_BASEMAP_ID)}
                  >
                    Blank
                  </button>
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
