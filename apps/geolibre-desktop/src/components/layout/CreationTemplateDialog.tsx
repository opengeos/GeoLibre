import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  creationTemplateLabels,
  useCreationTemplatePrompt,
} from "../../hooks/useCreationTemplatePrompt";

/** The radio value for starting without a template. */
const DEFAULTS_ONLY = "defaults";

/**
 * App-wide "choose a feature template" dialog backing
 * {@link useCreationTemplatePrompt}: shown before a geometry-edit session on an
 * ArcGIS layer that publishes several feature templates (#3179). Template
 * names and descriptions come from the service and render as plain text.
 */
export function CreationTemplateDialog() {
  const { t } = useTranslation();
  const request = useCreationTemplatePrompt((state) => state.request);
  const choose = useCreationTemplatePrompt((state) => state.choose);
  const cancel = useCreationTemplatePrompt((state) => state.cancel);
  const [selected, setSelected] = useState(DEFAULTS_ONLY);
  const labels = useMemo(() => creationTemplateLabels(request?.templates ?? []), [request]);

  // Every prompt starts on today's behavior: defaults only.
  useEffect(() => setSelected(DEFAULTS_ONLY), [request]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const template = request?.templates[Number(selected)];
    choose(selected === DEFAULTS_ONLY || !template ? {} : { template: template.selection });
  };

  const optionClass =
    "flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 text-start hover:bg-muted/50 has-[:checked]:border-primary has-[:checked]:bg-primary/5";

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open: boolean) => {
        if (!open) cancel();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("creationTemplatePrompt.title")}</DialogTitle>
          <DialogDescription>
            {t("creationTemplatePrompt.description", { layer: request?.layerName ?? "" })}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <fieldset className="max-h-[50vh] space-y-2 overflow-y-auto">
            <legend className="sr-only">{t("creationTemplatePrompt.groupLabel")}</legend>
            <label className={optionClass}>
              <input
                type="radio"
                name="creation-template"
                value={DEFAULTS_ONLY}
                checked={selected === DEFAULTS_ONLY}
                onChange={() => setSelected(DEFAULTS_ONLY)}
                className="mt-1"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {t("creationTemplatePrompt.defaultsOnly")}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t("creationTemplatePrompt.defaultsOnlyDescription")}
                </span>
              </span>
            </label>
            {request?.templates.map((template, index) => {
              const label = labels[index];
              const name = label.name ?? t("creationTemplatePrompt.unnamed");
              return (
                <label key={template.selection.index} className={optionClass}>
                  <input
                    type="radio"
                    name="creation-template"
                    value={String(index)}
                    checked={selected === String(index)}
                    onChange={() => setSelected(String(index))}
                    className="mt-1"
                  />
                  <span className="min-w-0">
                    <span className="block break-words text-sm font-medium">
                      {label.occurrence
                        ? t("creationTemplatePrompt.duplicateName", {
                            name,
                            n: label.occurrence,
                          })
                        : name}
                    </span>
                    {label.type ? (
                      <span className="block break-words text-xs text-muted-foreground">
                        {t("creationTemplatePrompt.typeLabel", { type: label.type })}
                      </span>
                    ) : null}
                    {template.description ? (
                      <span className="block break-words text-xs text-muted-foreground">
                        {template.description}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </fieldset>
          <p className="text-xs text-muted-foreground">{t("creationTemplatePrompt.editingNote")}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => cancel()}>
              {t("common.cancel")}
            </Button>
            <Button type="submit">{t("creationTemplatePrompt.start")}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
