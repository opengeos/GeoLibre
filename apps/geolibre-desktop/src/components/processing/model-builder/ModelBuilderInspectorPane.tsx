import type { TFunction } from "i18next";
import { cn, ScrollArea, Label, Select, Button } from "@geolibre/ui";
import { COMPACT_PANE_WIDTH } from "./model-builder-constants";
import { NodeInspector } from "./NodeInspector";
import {
  portFeedsOutput,
  setNodeField,
  setNodeParameter,
  removeNode,
} from "../../../lib/model-graph-edit";
import { Trash2 } from "lucide-react";
import type {
  GeoLibreLayer,
  ModelGraphNode,
  ProcessingModelGraph,
  ProcessingModel,
} from "@geolibre/core";
import type { ModelToolDescriptor, ModelGraphIssue } from "@geolibre/processing";
import type { Dispatch, SetStateAction } from "react";

interface ModelBuilderInspectorPaneProps {
  compact: boolean;
  size: { width: number; height: number };
  inspectorWidth: number;
  maxSideWidth: number;
  selectedNode: ModelGraphNode | null;
  resolveDescriptor: (
    provider: string | undefined,
    toolId: string | undefined,
  ) => ModelToolDescriptor | undefined;
  layers: GeoLibreLayer[];
  graph: ProcessingModelGraph;
  fieldsByLayer: Map<string, string[]>;
  issuesByNode: Map<string, ModelGraphIssue[]>;
  handleKeepResult: (nodeId: string, portId: string, name: string) => void;
  commitGraph: (
    updater: ProcessingModelGraph | ((current: ProcessingModelGraph) => ProcessingModelGraph),
    coalesceKey?: string,
  ) => void;
  setArmedPort: Dispatch<SetStateAction<{ nodeId: string; portId: string } | null>>;
  selectSingleNode: (id: string | null) => void;
  savedModels: ProcessingModel[];
  t: TFunction<"translation", undefined>;
  handleLoadModel: (model: ProcessingModel) => boolean;
  handleDeleteModel: () => void;
  modelId: string;
}

/** The Model Builder's right-hand pane: the selected node's inspector and the saved models list. */
export function ModelBuilderInspectorPane({
  compact,
  size,
  inspectorWidth,
  maxSideWidth,
  selectedNode,
  resolveDescriptor,
  layers,
  graph,
  fieldsByLayer,
  issuesByNode,
  handleKeepResult,
  commitGraph,
  setArmedPort,
  selectSingleNode,
  savedModels,
  t,
  handleLoadModel,
  handleDeleteModel,
  modelId,
}: ModelBuilderInspectorPaneProps) {
  return (
    <div
      className={cn(
        "flex flex-col border-s bg-card",
        compact ? "absolute inset-y-0 end-0 z-20 shadow-lg" : "shrink-0",
      )}
      style={{
        width: compact
          ? Math.min(COMPACT_PANE_WIDTH, Math.max(160, size.width - 48))
          : Math.min(inspectorWidth, maxSideWidth),
      }}
    >
      <ScrollArea className="min-h-0 flex-1 p-2">
        <NodeInspector
          node={selectedNode}
          descriptor={
            selectedNode ? resolveDescriptor(selectedNode.provider, selectedNode.toolId) : undefined
          }
          layers={layers}
          graph={graph}
          fieldsByLayer={fieldsByLayer}
          issues={selectedNode ? (issuesByNode.get(selectedNode.id) ?? []) : []}
          keptPorts={
            selectedNode
              ? new Set(
                  (resolveDescriptor(selectedNode.provider, selectedNode.toolId)?.outputs ?? [])
                    .filter((port) => portFeedsOutput(graph, selectedNode.id, port.id))
                    .map((port) => port.id),
                )
              : new Set<string>()
          }
          onKeepResult={(portId, name) =>
            selectedNode && handleKeepResult(selectedNode.id, portId, name)
          }
          onFieldChange={(field, value) =>
            selectedNode &&
            commitGraph(
              (current) => setNodeField(current, selectedNode.id, field, value),
              `field:${selectedNode.id}:${field}`,
            )
          }
          onParamChange={(paramId, value) =>
            selectedNode &&
            commitGraph(
              (current) => setNodeParameter(current, selectedNode.id, paramId, value),
              `param:${selectedNode.id}:${paramId}`,
            )
          }
          onRemove={() => {
            if (!selectedNode) return;
            commitGraph((current) => removeNode(current, selectedNode.id));
            // An armed port on the node being deleted would otherwise stay
            // armed and wire the next activation to a node that is gone.
            setArmedPort((current) => (current?.nodeId === selectedNode.id ? null : current));
            selectSingleNode(null);
          }}
        />
      </ScrollArea>
      {savedModels.length > 0 && (
        <div className="border-t p-2">
          <Label htmlFor="model-saved-picker" className="text-[11px]">
            {t("processing.modelBuilder.savedModels")}
          </Label>
          <div className="mt-1 flex items-center gap-1">
            <Select
              id="model-saved-picker"
              className="h-7 min-w-0 flex-1 text-xs"
              value=""
              onChange={(event) => {
                const model = savedModels.find((entry) => entry.id === event.target.value);
                if (model) handleLoadModel(model);
              }}
            >
              <option value="">{t("processing.modelBuilder.loadModelPlaceholder")}</option>
              {savedModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name || t("processing.modelBuilder.untitledModel")}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 shrink-0 p-0"
              onClick={handleDeleteModel}
              disabled={!savedModels.some((model) => model.id === modelId)}
              title={t("processing.modelBuilder.deleteModel")}
              aria-label={t("processing.modelBuilder.deleteModel")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
