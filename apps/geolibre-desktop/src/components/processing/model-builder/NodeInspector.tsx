// The Model Builder inspector for the selected node.

import type { GeoLibreLayer, ModelGraphNode, ProcessingModelGraph } from "@geolibre/core";
import type { ModelGraphIssue, ModelToolDescriptor } from "@geolibre/processing";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { Save, Trash2 } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  modelProviderCatalog,
  translateParameter,
  translateToolDescription,
} from "../../../lib/processing-tool-i18n";
import { parseMaxIterations } from "../../../lib/model-graph-edit";
import { modelFieldOptions } from "../../../lib/model-field-options";
import { ParameterField } from "../ParameterField";
import { translateIssue, nodeInspectorTitle, portLabel } from "./model-builder-labels";

const NULL_CHECK_OPERATORS = new Set(["is_null", "not_null", "is_empty", "not_empty"]);

/** Right-hand properties panel for whichever node is selected. */
export function NodeInspector({
  node,
  descriptor,
  layers,
  graph,
  fieldsByLayer,
  issues,
  keptPorts,
  onFieldChange,
  onParamChange,
  onKeepResult,
  onRemove,
}: {
  node: ModelGraphNode | null;
  descriptor: ModelToolDescriptor | undefined;
  layers: GeoLibreLayer[];
  graph: ProcessingModelGraph;
  /** Column names per project layer id, for `type: "field"` parameters. */
  fieldsByLayer: ReadonlyMap<string, string[]>;
  issues: ModelGraphIssue[];
  /** Output ports of this node that already feed an `output` node. */
  keptPorts: Set<string>;
  onFieldChange: (field: "layerId" | "name", value: string) => void;
  onParamChange: (paramId: string, value: unknown) => void;
  onKeepResult: (portId: string, name: string) => void;
  onRemove: () => void;
}): ReactElement {
  const { t } = useTranslation();
  if (!node) {
    return (
      <p className="p-2 text-xs text-muted-foreground">
        {t("processing.modelBuilder.selectNodeHint")}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-semibold">{nodeInspectorTitle(t, node, descriptor)}</p>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          onClick={onRemove}
          aria-label={t("processing.modelBuilder.removeNode")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {issues.map((issue, index) => (
        <p key={index} className="text-[11px] text-destructive">
          {translateIssue(t, issue)}
        </p>
      ))}

      {node.kind === "input" && (
        <div className="space-y-1">
          <Label htmlFor="model-node-layer" className="text-[11px]">
            {t("processing.modelBuilder.sourceLayer")}
          </Label>
          <Select
            id="model-node-layer"
            className="h-7 w-full text-xs"
            value={node.layerId ?? ""}
            onChange={(event) => onFieldChange("layerId", event.target.value)}
          >
            <option value="">{t("processing.modelBuilder.chooseLayer")}</option>
            {layers.map((layer) => (
              <option key={layer.id} value={layer.id}>
                {layer.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      {node.kind === "output" && (
        <div className="space-y-1">
          <Label htmlFor="model-node-name" className="text-[11px]">
            {t("processing.modelBuilder.resultName")}
          </Label>
          <Input
            id="model-node-name"
            className="h-7 text-xs"
            value={node.name ?? ""}
            onChange={(event) => onFieldChange("name", event.target.value)}
            placeholder={t("processing.modelBuilder.resultNamePlaceholder")}
          />
        </div>
      )}

      {node.kind === "conditional-switch" && (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground">
            {t("processing.modelBuilder.controlFlow.switch.description")}
          </p>
          <div className="space-y-1">
            <Label htmlFor="switch-condition-type" className="text-[11px]">
              {t("processing.modelBuilder.controlFlow.switch.conditionType")}
            </Label>
            <Select
              id="switch-condition-type"
              className="h-7 w-full text-xs"
              value={String(node.parameters?.conditionType || "compare")}
              onChange={(event) => {
                onParamChange("conditionType", event.target.value);
                // A null check needs a null/empty operator (the node starts on
                // "=="), and a comparison must not keep one, or it would still
                // run as a null check and ignore the target value.
                const operator = String(node.parameters?.operator ?? "");
                const nullOperator = NULL_CHECK_OPERATORS.has(operator);
                if (event.target.value === "null_check" && !nullOperator) {
                  onParamChange("operator", "is_null");
                } else if (event.target.value === "compare" && nullOperator) {
                  onParamChange("operator", "==");
                }
              }}
            >
              <option value="compare">
                {t("processing.modelBuilder.controlFlow.switch.typeCompare")}
              </option>
              <option value="boolean">
                {t("processing.modelBuilder.controlFlow.switch.typeBoolean")}
              </option>
              <option value="null_check">
                {t("processing.modelBuilder.controlFlow.switch.typeNullCheck")}
              </option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="switch-property" className="text-[11px]">
              {t("processing.modelBuilder.controlFlow.switch.property")}
            </Label>
            <Input
              id="switch-property"
              className="h-7 text-xs"
              value={String(node.parameters?.property ?? "")}
              onChange={(event) => onParamChange("property", event.target.value)}
              placeholder={t("processing.modelBuilder.controlFlow.switch.propertyPlaceholder")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="switch-operator" className="text-[11px]">
              {t("processing.modelBuilder.controlFlow.switch.operator")}
            </Label>
            <Select
              id="switch-operator"
              className="h-7 w-full text-xs"
              value={String(node.parameters?.operator || "==")}
              onChange={(event) => onParamChange("operator", event.target.value)}
            >
              <option value="==">{t("processing.modelBuilder.controlFlow.switch.opEqual")}</option>
              <option value="!=">
                {t("processing.modelBuilder.controlFlow.switch.opNotEqual")}
              </option>
              <option value="<">{t("processing.modelBuilder.controlFlow.switch.opLess")}</option>
              <option value="<=">
                {t("processing.modelBuilder.controlFlow.switch.opLessOrEqual")}
              </option>
              <option value=">">{t("processing.modelBuilder.controlFlow.switch.opGreater")}</option>
              <option value=">=">
                {t("processing.modelBuilder.controlFlow.switch.opGreaterOrEqual")}
              </option>
              <option value="contains">
                {t("processing.modelBuilder.controlFlow.switch.opContains")}
              </option>
              <option value="starts_with">
                {t("processing.modelBuilder.controlFlow.switch.opStartsWith")}
              </option>
              <option value="ends_with">
                {t("processing.modelBuilder.controlFlow.switch.opEndsWith")}
              </option>
              <option value="is_empty">
                {t("processing.modelBuilder.controlFlow.switch.opIsEmpty")}
              </option>
              <option value="not_empty">
                {t("processing.modelBuilder.controlFlow.switch.opNotEmpty")}
              </option>
              <option value="is_null">
                {t("processing.modelBuilder.controlFlow.switch.opIsNull")}
              </option>
              <option value="not_null">
                {t("processing.modelBuilder.controlFlow.switch.opNotNull")}
              </option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="switch-value" className="text-[11px]">
              {t("processing.modelBuilder.controlFlow.switch.value")}
            </Label>
            <Input
              id="switch-value"
              className="h-7 text-xs"
              value={String(node.parameters?.value ?? "")}
              onChange={(event) => onParamChange("value", event.target.value)}
              placeholder={t("processing.modelBuilder.controlFlow.switch.valuePlaceholder")}
            />
          </div>
        </div>
      )}

      {(node.kind === "iterate-features" || node.kind === "iterate-rasters") && (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground">
            {node.kind === "iterate-features"
              ? t("processing.modelBuilder.controlFlow.iterate.featuresDescription")
              : t("processing.modelBuilder.controlFlow.iterate.rastersDescription")}
          </p>
          <div className="space-y-1">
            <Label htmlFor="iter-max" className="text-[11px]">
              {t("processing.modelBuilder.controlFlow.iterate.maxIterations")}
            </Label>
            <Input
              id="iter-max"
              type="number"
              min={1}
              step={1}
              placeholder="1000"
              value={
                node.parameters?.maxIterations !== undefined
                  ? String(node.parameters.maxIterations)
                  : ""
              }
              onChange={(event) =>
                onParamChange("maxIterations", parseMaxIterations(event.target.value))
              }
            />
          </div>
          <div className="flex items-center justify-between pt-1">
            <Label htmlFor="iter-stop-on-error" className="text-[11px]">
              {t("processing.modelBuilder.controlFlow.iterate.stopOnError")}
            </Label>
            <input
              id="iter-stop-on-error"
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
              checked={node.parameters?.stopOnError !== false}
              onChange={(event) => onParamChange("stopOnError", event.target.checked)}
            />
          </div>
        </div>
      )}

      {node.kind === "collect-results" && (
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">
            {t("processing.modelBuilder.controlFlow.collectDescription")}
          </p>
        </div>
      )}

      {node.kind === "conditional-merge" && (
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">
            {t("processing.modelBuilder.controlFlow.mergeDescription")}
          </p>
        </div>
      )}

      {node.kind === "tool" && descriptor && (
        <div className="space-y-2">
          {descriptor.description && (
            <p className="text-[11px] text-muted-foreground">
              {translateToolDescription(t, modelProviderCatalog(descriptor.provider), {
                id: descriptor.toolId,
                name: descriptor.name,
                description: descriptor.description,
              })}
            </p>
          )}
          {descriptor.parameters.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {t("processing.modelBuilder.noParameters")}
            </p>
          ) : (
            descriptor.parameters.map((param) => (
              <ParameterField
                key={param.id}
                param={translateParameter(
                  t,
                  modelProviderCatalog(descriptor.provider),
                  descriptor.toolId,
                  param,
                )}
                value={node.parameters?.[param.id]}
                layerOptions={layers.map((layer) => ({
                  id: layer.id,
                  name: layer.name,
                }))}
                fieldOptions={
                  param.type === "field"
                    ? modelFieldOptions(graph, node, descriptor, param, fieldsByLayer)
                    : undefined
                }
                freeText
                onChange={(value) => onParamChange(param.id, value)}
              />
            ))
          )}
          {/* A model keeps only what an output node is wired to, so a mid-chain
              tool's result is computed and discarded unless the user knows to
              add a second output node and fan the port out to it. This makes
              that one click, per output port. */}
          {descriptor.outputs.length > 0 && (
            <div className="space-y-1 border-t pt-2">
              <p className="text-[11px] text-muted-foreground">
                {t("processing.modelBuilder.keepResultHint")}
              </p>
              {descriptor.outputs.map((port) => (
                <Button
                  key={port.id}
                  size="sm"
                  variant="outline"
                  className="h-6 w-full justify-start px-1.5 text-[11px]"
                  disabled={keptPorts.has(port.id)}
                  // Name the result after the tool, so a model that keeps
                  // several steps does not put a stack of layers all called
                  // "Model output" on the map. A multi-output tool adds the
                  // port, since its two results are not the same thing.
                  onClick={() =>
                    onKeepResult(
                      port.id,
                      descriptor.outputs.length === 1
                        ? descriptor.name
                        : `${descriptor.name} (${portLabel(t, port.label)})`,
                    )
                  }
                >
                  <Save className="me-1 h-3 w-3" />
                  {/* A one-output tool's port name is noise ("Keep \"Output\""),
                      so only name the port when there is a choice to make. */}
                  {descriptor.outputs.length === 1
                    ? keptPorts.has(port.id)
                      ? t("processing.modelBuilder.resultKeptSingle")
                      : t("processing.modelBuilder.keepResultSingle")
                    : keptPorts.has(port.id)
                      ? t("processing.modelBuilder.resultKept", {
                          port: portLabel(t, port.label),
                        })
                      : t("processing.modelBuilder.keepResult", {
                          port: portLabel(t, port.label),
                        })}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
