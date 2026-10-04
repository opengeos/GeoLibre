import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { LayerMetadataIssue, LayerMetadataIssueCode } from "@geolibre/core";
import { Button, Input, Label, Textarea } from "@geolibre/ui";
import { Plus, Trash2 } from "lucide-react";
import type { LayerMetadataDraft, LayerMetadataLinkDraft } from "./layer-metadata-draft";

/** Common SPDX identifiers offered as suggestions in the License field. */
const LICENSE_SUGGESTIONS = [
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "CC0-1.0",
  "ODbL-1.0",
  "PDDL-1.0",
  "OGL-UK-3.0",
  "MIT",
  "Apache-2.0",
  "proprietary",
];

/** Link relations offered as suggestions in a link row. */
const LINK_REL_SUGGESTIONS = ["related", "about", "license", "describedby", "via", "alternate"];

const ISSUE_MESSAGE_KEYS = {
  email: "layers.metadataEdit.errorEmail",
  url: "layers.metadataEdit.errorUrl",
  date: "layers.metadataEdit.errorDate",
  dateOrder: "layers.metadataEdit.errorDateOrder",
} as const satisfies Record<LayerMetadataIssueCode, string>;

interface LayerMetadataFormProps {
  draft: LayerMetadataDraft;
  issues: LayerMetadataIssue[];
  onChange: (draft: LayerMetadataDraft) => void;
}

/**
 * Editable descriptive-metadata fields of the layer Metadata dialog. The form
 * is controlled: the dialog owns the draft and commits it on Save.
 */
export function LayerMetadataForm({ draft, issues, onChange }: LayerMetadataFormProps) {
  const { t } = useTranslation();
  const baseId = useId();
  const id = (name: string) => `${baseId}-${name}`;
  const issueFor = (field: string) => issues.find((issue) => issue.field === field);
  const set = <K extends keyof LayerMetadataDraft>(key: K, value: LayerMetadataDraft[K]) =>
    onChange({ ...draft, [key]: value });
  const setLink = (index: number, patch: Partial<LayerMetadataLinkDraft>) =>
    set(
      "links",
      draft.links.map((link, i) => (i === index ? { ...link, ...patch } : link)),
    );

  const errorText = (field: string): ReactNode => {
    const issue = issueFor(field);
    if (!issue) return null;
    return (
      <p id={id(`${field}-error`)} role="alert" className="text-xs text-destructive">
        {t(ISSUE_MESSAGE_KEYS[issue.code])}
      </p>
    );
  };
  const invalidProps = (field: string) =>
    issueFor(field)
      ? { "aria-invalid": true as const, "aria-describedby": id(`${field}-error`) }
      : {};

  const textField = (
    key: "title" | "attribution",
    labelKey: "layers.metadataEdit.title" | "layers.metadataEdit.attribution",
  ) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id(key)}>{t(labelKey)}</Label>
      <Input id={id(key)} value={draft[key]} onChange={(e) => set(key, e.target.value)} />
    </div>
  );

  return (
    <div className="flex flex-col gap-3" data-testid="layer-metadata-form">
      {textField("title", "layers.metadataEdit.title")}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id("abstract")}>{t("layers.metadataEdit.abstract")}</Label>
        <Textarea
          id={id("abstract")}
          rows={3}
          value={draft.abstract}
          onChange={(e) => set("abstract", e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id("keywords")}>{t("layers.metadataEdit.keywords")}</Label>
        <Input
          id={id("keywords")}
          value={draft.keywords}
          aria-describedby={id("keywords-hint")}
          onChange={(e) => set("keywords", e.target.value)}
        />
        <p id={id("keywords-hint")} className="text-xs text-muted-foreground">
          {t("layers.metadataEdit.keywordsHint")}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id("license")}>{t("layers.metadataEdit.license")}</Label>
          <Input
            id={id("license")}
            list={id("license-options")}
            placeholder={t("layers.metadataEdit.licensePlaceholder")}
            value={draft.license}
            onChange={(e) => set("license", e.target.value)}
          />
          <datalist id={id("license-options")}>
            {LICENSE_SUGGESTIONS.map((license) => (
              <option key={license} value={license} aria-label={license} />
            ))}
          </datalist>
        </div>
        {textField("attribution", "layers.metadataEdit.attribution")}
      </div>

      <fieldset className="flex flex-col gap-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">{t("layers.metadataEdit.contact")}</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id("contactName")}>{t("layers.metadataEdit.contactName")}</Label>
            <Input
              id={id("contactName")}
              autoComplete="off"
              value={draft.contactName}
              onChange={(e) => set("contactName", e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id("contactEmail")}>{t("layers.metadataEdit.contactEmail")}</Label>
            <Input
              id={id("contactEmail")}
              type="email"
              autoComplete="off"
              value={draft.contactEmail}
              onChange={(e) => set("contactEmail", e.target.value)}
              {...invalidProps("contact.email")}
            />
            {errorText("contact.email")}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id("contactOrganization")}>
              {t("layers.metadataEdit.contactOrganization")}
            </Label>
            <Input
              id={id("contactOrganization")}
              autoComplete="off"
              value={draft.contactOrganization}
              onChange={(e) => set("contactOrganization", e.target.value)}
            />
          </div>
        </div>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id("lineage")}>{t("layers.metadataEdit.lineage")}</Label>
        <Textarea
          id={id("lineage")}
          rows={2}
          placeholder={t("layers.metadataEdit.lineagePlaceholder")}
          value={draft.lineage}
          onChange={(e) => set("lineage", e.target.value)}
        />
      </div>

      <fieldset className="flex flex-col gap-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">
          {t("layers.metadataEdit.temporalExtent")}
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id("temporalStart")}>{t("layers.metadataEdit.temporalStart")}</Label>
            <Input
              id={id("temporalStart")}
              placeholder={t("layers.metadataEdit.datePlaceholder")}
              value={draft.temporalStart}
              onChange={(e) => set("temporalStart", e.target.value)}
              {...invalidProps("temporalExtent.start")}
            />
            {errorText("temporalExtent.start")}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id("temporalEnd")}>{t("layers.metadataEdit.temporalEnd")}</Label>
            <Input
              id={id("temporalEnd")}
              placeholder={t("layers.metadataEdit.datePlaceholder")}
              value={draft.temporalEnd}
              onChange={(e) => set("temporalEnd", e.target.value)}
              {...invalidProps("temporalExtent.end")}
            />
            {errorText("temporalExtent.end")}
          </div>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">{t("layers.metadataEdit.links")}</legend>
        <datalist id={id("rel-options")}>
          {LINK_REL_SUGGESTIONS.map((rel) => (
            <option key={rel} value={rel} aria-label={rel} />
          ))}
        </datalist>
        {draft.links.map((link, index) => {
          const field = `links.${index}.href`;
          return (
            <div key={index} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-end gap-2 sm:flex-nowrap">
                <div className="flex w-full min-w-0 flex-col gap-1.5 sm:w-auto sm:flex-[3]">
                  <Label htmlFor={id(`link-${index}-href`)}>
                    {t("layers.metadataEdit.linkHref")}
                  </Label>
                  <Input
                    id={id(`link-${index}-href`)}
                    type="url"
                    placeholder="https://"
                    value={link.href}
                    onChange={(e) => setLink(index, { href: e.target.value })}
                    {...invalidProps(field)}
                  />
                </div>
                <div className="flex w-28 flex-none flex-col gap-1.5">
                  <Label htmlFor={id(`link-${index}-rel`)}>
                    {t("layers.metadataEdit.linkRel")}
                  </Label>
                  <Input
                    id={id(`link-${index}-rel`)}
                    list={id("rel-options")}
                    placeholder="related"
                    value={link.rel}
                    onChange={(e) => setLink(index, { rel: e.target.value })}
                  />
                </div>
                <div className="flex min-w-0 flex-[2] flex-col gap-1.5">
                  <Label htmlFor={id(`link-${index}-title`)}>
                    {t("layers.metadataEdit.linkTitle")}
                  </Label>
                  <Input
                    id={id(`link-${index}-title`)}
                    value={link.title}
                    onChange={(e) => setLink(index, { title: e.target.value })}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("layers.metadataEdit.removeLink", { index: index + 1 })}
                  title={t("layers.metadataEdit.removeLink", { index: index + 1 })}
                  onClick={() =>
                    set(
                      "links",
                      draft.links.filter((_, i) => i !== index),
                    )
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {errorText(field)}
            </div>
          );
        })}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => set("links", [...draft.links, { href: "", rel: "", title: "" }])}
          >
            <Plus className="h-4 w-4" />
            {t("layers.metadataEdit.addLink")}
          </Button>
        </div>
      </fieldset>
    </div>
  );
}
