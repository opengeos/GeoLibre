// Display names for Model Builder tools, ports, control-flow nodes and validation issues.

import type { ModelGraphNodeKind } from "@geolibre/core";
import {
  INPUT_NODE_PORT,
  OUTPUT_NODE_PORT,
  type ModelGraphIssue,
  type ModelToolDescriptor,
} from "@geolibre/processing";
import type { ParseKeys, TFunction } from "i18next";
import { modelProviderCatalog, translateToolName } from "../../../lib/processing-tool-i18n";

// Catalog key for each control-flow node's card title.
export const CONTROL_FLOW_TITLE_KEYS: Partial<Record<ModelGraphNodeKind, ParseKeys>> = {
  "iterate-features": "processing.modelBuilder.controlFlow.kinds.iterateFeatures",
  "iterate-rasters": "processing.modelBuilder.controlFlow.kinds.iterateRasters",
  "collect-results": "processing.modelBuilder.controlFlow.kinds.collectResults",
  "conditional-switch": "processing.modelBuilder.controlFlow.kinds.conditionalSwitch",
  "conditional-merge": "processing.modelBuilder.controlFlow.kinds.conditionalMerge",
};

/**
 * Resolve a validation issue to the user's language.
 *
 * `ModelGraphIssue` carries a machine-readable `code` precisely so the UI can
 * translate rather than print the engine's English `message`; rendering the
 * message verbatim left every validation problem English-only in all 19
 * locales. Port names and tool ids inside a message are data, so they are
 * interpolated rather than translated.
 */
export function translateIssue(t: TFunction, issue: ModelGraphIssue): string {
  switch (issue.code) {
    case "missing-layer":
      return t("processing.modelBuilder.issueMissingLayer");
    case "unknown-tool":
      return t("processing.modelBuilder.issueUnknownTool", {
        tool: issue.detail ?? "",
      });
    case "missing-input":
      return t("processing.modelBuilder.issueMissingInput", {
        port: issue.detail ?? "",
      });
    case "unknown-port":
      return t("processing.modelBuilder.issueUnknownPort");
    case "duplicate-input":
      return t("processing.modelBuilder.issueDuplicateInput", {
        port: issue.detail ?? "",
      });
    case "type-mismatch":
      return t("processing.modelBuilder.issueTypeMismatch");
    case "cycle":
      return t("processing.modelBuilder.issueCycle");
    case "no-output":
      return t("processing.modelBuilder.issueNoOutput");
    case "duplicate-node":
      return t("processing.modelBuilder.issueDuplicateNode");
    case "dangling-edge":
      return t("processing.modelBuilder.issueDanglingEdge");
    default:
      return issue.message;
  }
}

/**
 * Display name for a tool node, translated where GeoLibre owns the metadata.
 *
 * The palette, the canvas card, the inspector header and the run log all name
 * the same tool, so they resolve it the same way; a raw `descriptor.name` at any
 * one of them shows an English tool name inside an otherwise translated dialog.
 * Whitebox descriptors resolve to their catalog text, as everywhere else.
 */
export function descriptorName(
  t: TFunction,
  descriptor: ModelToolDescriptor | undefined,
  fallback = "",
): string {
  if (!descriptor) return fallback;
  return translateToolName(t, modelProviderCatalog(descriptor.provider), {
    id: descriptor.toolId,
    name: descriptor.name,
  });
}

// Control-flow nodes' port labels come from @geolibre/processing, which has no
// i18n; map their English labels to catalog keys.
const CONTROL_FLOW_PORT_KEYS: Record<string, ParseKeys> = {
  "Feature Collection": "processing.modelBuilder.controlFlow.ports.featureCollection",
  "Current Feature": "processing.modelBuilder.controlFlow.ports.currentFeature",
  Index: "processing.modelBuilder.controlFlow.ports.index",
  "Total Count": "processing.modelBuilder.controlFlow.ports.totalCount",
  "Raster Collection": "processing.modelBuilder.controlFlow.ports.rasterCollection",
  "Current Raster": "processing.modelBuilder.controlFlow.ports.currentRaster",
  "Raster Name": "processing.modelBuilder.controlFlow.ports.rasterName",
  "Item to Collect": "processing.modelBuilder.controlFlow.ports.itemToCollect",
  "Collected Results": "processing.modelBuilder.controlFlow.ports.collectedResults",
  Count: "processing.modelBuilder.controlFlow.ports.count",
  "Condition Value": "processing.modelBuilder.controlFlow.ports.conditionValue",
  "True Branch": "processing.modelBuilder.controlFlow.ports.trueBranch",
  "False Branch": "processing.modelBuilder.controlFlow.ports.falseBranch",
  "True Result": "processing.modelBuilder.controlFlow.ports.trueResult",
  "False Result": "processing.modelBuilder.controlFlow.ports.falseResult",
  "Active Output": "processing.modelBuilder.controlFlow.ports.activeOutput",
};

/** Display name for a port, translating the synthetic node ports and the control-flow ports. */
export function portLabel(t: TFunction, label: string): string {
  if (label === INPUT_NODE_PORT) return t("processing.modelBuilder.outputNode");
  if (label === OUTPUT_NODE_PORT) return t("processing.modelBuilder.inputNode");
  const key = Object.hasOwn(CONTROL_FLOW_PORT_KEYS, label)
    ? CONTROL_FLOW_PORT_KEYS[label]
    : undefined;
  return key ? t(key) : label;
}
