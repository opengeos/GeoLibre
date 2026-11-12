import {
  getAttributeFormField,
  isAttributeFormFieldVisible,
  type AttributeFormConfig,
  type AttributeFormFieldConfig,
} from "@geolibre/core";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { ImagePlus, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_PHOTO_BYTES,
  orderFormFields,
  type CollectionField,
  type CollectionSchema,
} from "../../lib/field-collection";

/**
 * Raster pictures only. An SVG is inert inside `<img>`, but the stored value
 * is drawn elsewhere too, and a vector document has no place in a photo field.
 */
const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/i;
/** Longest data URL of a picture within {@link MAX_PHOTO_BYTES}. */
const MAX_ATTACHMENT_DATA_URL_LENGTH = Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 64;

interface FieldCollectionFormFieldsProps {
  schema: CollectionSchema;
  /** Attribute Form config narrowed to this schema's fields. */
  attributeForm?: AttributeFormConfig;
  /** Candidate properties for visibility expressions; null without a form. */
  candidateProps: Record<string, unknown> | null;
  values: Record<string, string>;
  setValue: (key: string, value: string) => void;
  errors: Record<string, string>;
  errorText: (code: string | undefined) => string | null;
  /** Changes with each record, so a picture still loading stays with its own. */
  captureKey: string;
}

/**
 * The attribute inputs of the Field Collection capture form: one per schema
 * field, drawn with the widget the layer's Attribute Form assigns it, under
 * the form's section headings when it has any.
 */
export function FieldCollectionFormFields({
  schema,
  attributeForm,
  candidateProps,
  values,
  setValue,
  errors,
  errorText,
  captureKey,
}: FieldCollectionFormFieldsProps) {
  // A heading is drawn once per run: sections whose fields are all hidden
  // leave nothing between two parts of the same group.
  let lastTitle = "";
  return (
    <>
      {orderFormFields(schema.fields, attributeForm?.sections).map((group, index) => {
        const inputs = group.fields.flatMap((field) => {
          const config = getAttributeFormField(attributeForm, field.key);
          // Conditional visibility: a hidden field disappears from the form
          // (and its validation is skipped on save). Evaluated against the
          // current candidate values so it updates as the user types.
          if (config && candidateProps && !isAttributeFormFieldVisible(config, candidateProps)) {
            return [];
          }
          return [
            <FormField
              key={field.key}
              field={field}
              config={config}
              value={values[field.key] ?? ""}
              onChange={(value) => setValue(field.key, value)}
              error={errorText(errors[field.key])}
              captureKey={captureKey}
            />,
          ];
        });
        if (inputs.length === 0) return null;
        const showTitle = group.title !== "" && group.title !== lastTitle;
        lastTitle = group.title;
        return (
          <Fragment key={`${group.title}-${index}`}>
            {showTitle && (
              <h3 className="border-b pb-1 pt-2 text-sm font-semibold text-foreground">
                {group.title}
              </h3>
            )}
            {inputs}
          </Fragment>
        );
      })}
    </>
  );
}

interface FormFieldProps {
  field: CollectionField;
  config: AttributeFormFieldConfig | undefined;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  captureKey: string;
}

function FormField({ field, config, value, onChange, error, captureKey }: FormFieldProps) {
  const id = `fc-${field.key}`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {config?.alias?.trim() || field.label}
        {(field.required || config?.required) && <span className="ms-0.5 text-destructive">*</span>}
      </Label>
      {config?.widget === "valueMap" && config.valueMap?.length ? (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {config.valueMap.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label ?? entry.value}
            </option>
          ))}
        </Select>
      ) : config?.widget === "checkbox" ? (
        <div className="flex h-9 items-center">
          <input
            id={id}
            type="checkbox"
            className="h-4 w-4"
            checked={value === "true"}
            onChange={(e) => onChange(e.target.checked ? "true" : "false")}
          />
        </div>
      ) : config?.widget === "attachment" ? (
        <AttachmentInput id={id} value={value} onChange={onChange} captureKey={captureKey} />
      ) : config ? (
        <Input
          id={id}
          type={
            config.widget === "number" || config.widget === "range"
              ? "number"
              : config.widget === "date"
                ? "date"
                : "text"
          }
          min={config.min}
          max={config.max}
          step={config.step}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.type === "choice" && field.options?.length ? (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          id={id}
          type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * A picture stored in the field itself, as a data URL, so it travels with the
 * feature in the project file. Popups and the attribute table already draw
 * such a value as a thumbnail.
 */
function AttachmentInput({
  id,
  value,
  onChange,
  captureKey,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  captureKey: string;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A read that finishes after a newer pick (or a removal) must not win.
  const readSeq = useRef(0);
  // Nor one that finishes after its record was saved: it would land in the
  // next record's form.
  useEffect(() => {
    readSeq.current += 1;
    setProblem(null);
  }, [captureKey]);
  const isImage = RASTER_DATA_URL.test(value);

  const handleFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const tooLarge = () =>
      setProblem(
        t("fieldCollection.photoTooLarge", {
          max: `${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))} MB`,
        }),
      );
    if (file.size > MAX_PHOTO_BYTES) {
      tooLarge();
      return;
    }
    const seq = (readSeq.current += 1);
    const reader = new FileReader();
    reader.onerror = () => {
      if (readSeq.current === seq) setProblem(t("fieldCollection.photoReadError"));
    };
    reader.onload = () => {
      if (readSeq.current !== seq) return;
      const src = typeof reader.result === "string" ? reader.result : "";
      if (!RASTER_DATA_URL.test(src)) setProblem(t("fieldCollection.photoReadError"));
      // The stored value is base64, about 4/3 the size of the file it holds.
      else if (src.length > MAX_ATTACHMENT_DATA_URL_LENGTH) tooLarge();
      else {
        setProblem(null);
        onChange(src);
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-1.5">
      {isImage ? (
        <div className="relative inline-block">
          <img src={value} alt={t("fieldCollection.photo")} className="h-20 rounded-md" />
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="absolute end-0 top-0 h-6 w-6"
            aria-label={t("fieldCollection.removePhoto")}
            onClick={() => {
              readSeq.current += 1;
              onChange("");
            }}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : value ? (
        // An existing row's value: a file path written by QGIS or QField.
        <p className="break-all text-xs text-muted-foreground">{value}</p>
      ) : null}
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
        className="sr-only"
        onChange={handleFile}
      />
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => inputRef.current?.click()}
      >
        <ImagePlus className="me-2 h-4 w-4" />
        {t("fieldCollection.choosePhoto")}
      </Button>
      {problem && <p className="text-xs text-destructive">{problem}</p>}
    </div>
  );
}
