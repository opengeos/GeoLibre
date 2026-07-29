import { createProjectTemplate, useAppStore, type GeoLibreProject } from "@geolibre/core";
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
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { v4 as uuidv4 } from "uuid";

interface SaveTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  getProject: () => { project: GeoLibreProject; defaultProjectName: string };
}

export function SaveTemplateDialog({ open, onOpenChange, getProject }: SaveTemplateDialogProps) {
  const { t } = useTranslation();
  const saveTemplateEntry = useAppStore((s) => s.saveTemplateEntry);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [stripDataLayers, setStripDataLayers] = useState(true);

  const getProjectRef = useRef(getProject);
  useEffect(() => {
    getProjectRef.current = getProject;
  });

  useEffect(() => {
    if (open) {
      const { defaultProjectName } = getProjectRef.current();
      setName(defaultProjectName || t("template.defaultName"));
      setDescription("");
      setStripDataLayers(true);
    }
  }, [open, t]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const templateName = name.trim() || t("template.defaultName");
    const { project } = getProjectRef.current();
    const templateProject = createProjectTemplate(project, {
      name: templateName,
      stripDataLayers,
    });

    const now = new Date().toISOString();
    saveTemplateEntry({
      id: uuidv4(),
      name: templateName,
      description: description.trim() || undefined,
      project: templateProject,
      createdAt: now,
      updatedAt: now,
    });

    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("template.saveTitle")}</DialogTitle>
          <DialogDescription>{t("template.saveDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="template-name">{t("template.nameLabel")}</Label>
            <Input
              id="template-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("template.namePlaceholder")}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="template-description">{t("template.descriptionLabel")}</Label>
            <Input
              id="template-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("template.descriptionPlaceholder")}
            />
          </div>
          <div className="flex items-start gap-2.5 pt-1">
            <input
              type="checkbox"
              id="strip-data-layers"
              checked={stripDataLayers}
              onChange={(e) => setStripDataLayers(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
            />
            <Label
              htmlFor="strip-data-layers"
              className="cursor-pointer text-sm font-normal leading-snug"
            >
              <span className="block font-medium">{t("template.stripDataLayersLabel")}</span>
              <span className="block text-xs text-muted-foreground">
                {t("template.stripDataLayersDesc")}
              </span>
            </Label>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit">{t("template.saveAction")}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
