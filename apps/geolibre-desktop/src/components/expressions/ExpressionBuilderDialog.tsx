import {
  EXPRESSION_FUNCTION_CATEGORIES,
  type ExpressionVariable,
  evaluateMapExpression,
  formatExpressionPreviewValue,
  inferFieldTypes,
  isStyleSpecColor,
  substituteExpressionVariables,
  validateMapExpression,
} from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
} from "@geolibre/ui";
import type { Feature } from "geojson";
import type { ParseKeys } from "i18next";
import { ChevronLeft, ChevronRight, Eraser } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface ExpressionBuilderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * What the expression is for, shown in the dialog description and used in
   * shape-error messages (e.g. "Color expression", "Rule 2 filter").
   */
  targetLabel: string;
  /**
   * "filter" surfaces a matches / does-not-match preview and requires a
   * boolean result (rule filters); "color" requires a color result (style
   * expressions); "number" requires a numeric result (data-defined label
   * size/opacity/priority); "value" shows the evaluated value untyped
   * (label text).
   */
  context: "filter" | "color" | "value" | "number";
  initialExpression: string;
  /** The active layer's features; drive the field list and the live preview. */
  features: Feature[];
  /** Attribute field names offered for insertion (sorted by the caller). */
  fieldNames: string[];
  /** Current map zoom, used when the expression references ["zoom"]. */
  zoom: number;
  /** `@` variables offered for insertion, with their current values. */
  variables: ExpressionVariable[];
  onApply: (expression: string) => void;
}

/** Short badge text per inferred field type (not translated: symbolic). */
const FIELD_TYPE_BADGES: Record<string, string> = {
  string: "abc",
  number: "123",
  boolean: "t/f",
  mixed: "mix",
  unknown: "?",
};

/**
 * Shared Expression Builder dialog (GH #1306): a MapLibre expression editor
 * with a browsable function reference, the layer's fields, `@` variables, and
 * a live preview evaluated against a real feature. Validation runs through
 * the MapLibre style spec, so malformed expressions are caught here instead
 * of silently failing on the map. Reused by every expression entry point
 * (rule-based filters, expression style mode, label expressions).
 */
export function ExpressionBuilderDialog({
  open,
  onOpenChange,
  targetLabel,
  context,
  initialExpression,
  features,
  fieldNames,
  zoom,
  variables,
  onApply,
}: ExpressionBuilderDialogProps) {
  const { t } = useTranslation();
  const [source, setSource] = useState(initialExpression);
  const [sampleIndex, setSampleIndex] = useState(0);
  const [functionQuery, setFunctionQuery] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // No re-seed effect: the caller mounts this dialog only while open, so the
  // useState initializers above seed a fresh instance per open. Re-seeding on
  // `initialExpression` changes would let an external store mutation (e.g.
  // the global undo shortcut while a dialog button has focus) silently wipe
  // the user's draft.

  // The destination's required result type: filters must produce booleans and
  // style expressions colors; label expressions stay untyped (MapLibre
  // coerces text-field values).
  const expectedType =
    context === "filter"
      ? "boolean"
      : context === "color"
        ? "color"
        : context === "number"
          ? "number"
          : undefined;
  const validation = useMemo(
    () => validateMapExpression(source, { variables, expectedType }),
    [source, variables, expectedType],
  );
  const sampleFeature =
    features.length > 0 ? features[Math.min(sampleIndex, features.length - 1)] : null;
  const preview = useMemo(
    () =>
      evaluateMapExpression(source, {
        feature: sampleFeature,
        zoom,
        variables,
        expectedType,
      }),
    [source, sampleFeature, zoom, variables, expectedType],
  );
  const fieldTypes = useMemo(() => inferFieldTypes(features, fieldNames), [features, fieldNames]);

  const filteredCategories = useMemo(() => {
    const query = functionQuery.trim().toLowerCase();
    if (!query) return EXPRESSION_FUNCTION_CATEGORIES;
    return EXPRESSION_FUNCTION_CATEGORIES.map((category) => ({
      ...category,
      functions: category.functions.filter((entry) => entry.name.toLowerCase().includes(query)),
    })).filter((category) => category.functions.length > 0);
  }, [functionQuery]);

  // Insert a snippet at the caret and restore focus, mirroring the field
  // calculator's chip behavior (synchronous DOM write so rapid clicks never
  // read a stale caret).
  const insertSnippet = (snippet: string) => {
    const el = textareaRef.current;
    if (!el) {
      setSource((current) => current + snippet);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + snippet + el.value.slice(end);
    el.value = next;
    const caret = start + snippet.length;
    el.focus();
    el.setSelectionRange(caret, caret);
    setSource(next);
  };

  const shapeError = useMemo(() => {
    if (validation.ok) return null;
    switch (validation.code) {
      case "not-array":
        return t("style.expressionErrors.notArray", { label: targetLabel });
      case "not-operator":
        return t("style.expressionErrors.notOperator", { label: targetLabel });
      case "not-json":
        return t("style.expressionErrors.notJson", {
          label: targetLabel,
          message: validation.errors[0] ?? "",
        });
      default:
        return null;
    }
  }, [validation, targetLabel, t]);

  const handleApply = () => {
    // Always re-serialize the parsed expression: variables are compile-time
    // (the map render path knows nothing about @ tokens), and normalizing
    // also strips tolerated trailing commas that stricter downstream parsers
    // (e.g. the label expression check) would reject.
    const applied = validation.parsed
      ? JSON.stringify(substituteExpressionVariables(validation.parsed, variables))
      : "";
    onApply(applied);
    onOpenChange(false);
  };

  const previewBody = () => {
    if (preview.kind === "empty") {
      return (
        <p className="text-xs text-muted-foreground">{t("style.expressionBuilder.previewEmpty")}</p>
      );
    }
    if (preview.kind === "error") {
      return (
        <p className="break-words text-xs text-destructive">
          {shapeError ?? preview.errors?.join("; ")}
        </p>
      );
    }
    if (context === "filter") {
      const matches = Boolean(preview.value);
      return (
        <p
          className={[
            "text-xs font-medium",
            matches ? "text-primary" : "text-muted-foreground",
          ].join(" ")}
        >
          {matches
            ? t("style.expressionBuilder.filterMatches")
            : t("style.expressionBuilder.filterNoMatch")}
        </p>
      );
    }
    const value = preview.value;
    const colorish = isStyleSpecColor(value);
    const display = formatExpressionPreviewValue(value);
    return (
      <p className="flex items-center gap-2 break-all font-mono text-xs">
        {colorish ? (
          <span
            aria-hidden
            className="inline-block h-3.5 w-3.5 shrink-0 rounded-sm border"
            style={{ backgroundColor: display }}
          />
        ) : null}
        {display}
      </p>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("style.expressionBuilder.title")}</DialogTitle>
          <DialogDescription>{targetLabel}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="expressionBuilderSource">
                {t("style.expressionBuilder.expressionLabel")}
              </Label>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={!source}
                title={t("style.expressionBuilder.clear")}
                aria-label={t("style.expressionBuilder.clear")}
                onClick={() => {
                  setSource("");
                  textareaRef.current?.focus();
                }}
              >
                <Eraser className="h-3.5 w-3.5" />
              </Button>
            </div>
            <textarea
              id="expressionBuilderSource"
              ref={textareaRef}
              aria-invalid={!validation.ok}
              className={[
                "min-h-24 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs placeholder:text-muted-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0",
                validation.ok ? "border-input" : "border-destructive",
              ].join(" ")}
              placeholder='["==", ["get", "field"], "value"]'
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
            {!validation.ok ? (
              <p className="break-words text-xs text-destructive">
                {shapeError ?? validation.errors.join("; ")}
              </p>
            ) : source.trim() ? (
              <p className="text-xs text-muted-foreground">{t("style.expressionBuilder.valid")}</p>
            ) : null}
          </div>

          <div className="space-y-1.5 rounded-md border border-input p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">{t("style.expressionBuilder.preview")}</span>
              {features.length > 0 ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={sampleIndex <= 0}
                    title={t("style.expressionBuilder.previousFeature")}
                    aria-label={t("style.expressionBuilder.previousFeature")}
                    onClick={() => setSampleIndex((index) => Math.max(0, index - 1))}
                  >
                    <ChevronLeft className="h-3.5 w-3.5 rtl:rotate-180" />
                  </Button>
                  {t("style.expressionBuilder.sampleFeature", {
                    index: Math.min(sampleIndex, features.length - 1) + 1,
                    count: features.length,
                  })}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={sampleIndex >= features.length - 1}
                    title={t("style.expressionBuilder.nextFeature")}
                    aria-label={t("style.expressionBuilder.nextFeature")}
                    onClick={() =>
                      setSampleIndex((index) => Math.min(features.length - 1, index + 1))
                    }
                  >
                    <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />
                  </Button>
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {t("style.expressionBuilder.previewNoFeatures")}
                </span>
              )}
            </div>
            {previewBody()}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <span className="text-xs font-medium">{t("style.expressionBuilder.fields")}</span>
              <ScrollArea className="h-44 rounded-md border border-input">
                <div className="p-1">
                  {fieldNames.length === 0 ? (
                    <p className="p-2 text-xs text-muted-foreground">
                      {t("style.expressionBuilder.noFields")}
                    </p>
                  ) : (
                    fieldNames.map((name) => (
                      <button
                        key={name}
                        type="button"
                        className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-start font-mono text-xs hover:bg-accent"
                        title={t("style.expressionBuilder.insertField", { name })}
                        onClick={() => insertSnippet(`["get", ${JSON.stringify(name)}]`)}
                      >
                        <span className="truncate">{name}</span>
                        <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                          {FIELD_TYPE_BADGES[fieldTypes[name] ?? "unknown"]}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </ScrollArea>
            </div>

            <div className="space-y-1.5">
              <span className="text-xs font-medium">
                {t("style.expressionBuilder.functionsHeading")}
              </span>
              <Input
                value={functionQuery}
                placeholder={t("style.expressionBuilder.functionSearch")}
                aria-label={t("style.expressionBuilder.functionSearch")}
                className="h-7 text-xs"
                onChange={(event) => setFunctionQuery(event.target.value)}
              />
              <ScrollArea className="h-[8.75rem] rounded-md border border-input">
                <div className="p-1">
                  {filteredCategories.length === 0 ? (
                    <p className="p-2 text-xs text-muted-foreground">
                      {t("style.expressionBuilder.noFunctionMatches")}
                    </p>
                  ) : (
                    filteredCategories.map((category) => (
                      <div key={category.key} className="mb-1">
                        <p className="px-2 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                          {t(`style.expressionBuilder.categories.${category.key}` as ParseKeys)}
                        </p>
                        {category.functions.map((entry) => (
                          <button
                            key={entry.name}
                            type="button"
                            className="block w-full rounded px-2 py-1 text-start font-mono text-xs hover:bg-accent"
                            title={t(
                              `style.expressionBuilder.functions.${entry.docKey}` as ParseKeys,
                            )}
                            onClick={() => insertSnippet(entry.snippet)}
                          >
                            {entry.name}
                          </button>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </div>

            <div className="space-y-1.5">
              <span className="text-xs font-medium">{t("style.expressionBuilder.variables")}</span>
              <ScrollArea className="h-44 rounded-md border border-input">
                <div className="p-1">
                  {variables.map((variable) => (
                    <button
                      key={variable.token}
                      type="button"
                      className="block w-full rounded px-2 py-1 text-start text-xs hover:bg-accent"
                      title={String(variable.value)}
                      onClick={() => insertSnippet(JSON.stringify(variable.token))}
                    >
                      <span className="font-mono">{variable.token}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {String(variable.value)}
                      </span>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {t("style.expressionBuilder.variablesHint")}
          </p>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" disabled={!validation.ok} onClick={handleApply}>
              {t("style.expressionBuilder.apply")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
