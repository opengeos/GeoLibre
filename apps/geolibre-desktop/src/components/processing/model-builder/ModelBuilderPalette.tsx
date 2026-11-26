import type { TFunction } from "i18next";
import { cn, Input, Button, ScrollArea } from "@geolibre/ui";
import { COMPACT_PANE_WIDTH, TOOL_DRAG_TYPE } from "./model-builder-constants";
import {
  translateModelToolGroup,
  modelProviderCatalog,
  translateToolName,
  translateToolDescription,
} from "../../../lib/processing-tool-i18n";
import type { ModelToolDescriptor } from "@geolibre/processing";
import type { Dispatch, SetStateAction } from "react";

interface ModelBuilderPaletteProps {
  compact: boolean;
  size: { width: number; height: number };
  paletteWidth: number;
  maxSideWidth: number;
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  t: TFunction<"translation", undefined>;
  addNode: (kind: "input" | "output") => void;
  addControlFlowNode: (
    kind:
      | "iterate-features"
      | "iterate-rasters"
      | "collect-results"
      | "conditional-switch"
      | "conditional-merge",
  ) => void;
  catalog: ModelToolDescriptor[];
  groups: { group: string; tools: ModelToolDescriptor[] }[];
  addToolAtDefault: (descriptor: ModelToolDescriptor) => void;
}

/** The Model Builder's tool palette: search, input/output and control-flow nodes, and the tool catalog. */
export function ModelBuilderPalette({
  compact,
  size,
  paletteWidth,
  maxSideWidth,
  search,
  setSearch,
  t,
  addNode,
  addControlFlowNode,
  catalog,
  groups,
  addToolAtDefault,
}: ModelBuilderPaletteProps) {
  return (
    <div
      className={cn(
        "flex flex-col bg-card",
        compact ? "absolute inset-y-0 start-0 z-20 shadow-lg" : "shrink-0",
        "border-e",
      )}
      style={{
        width: compact
          ? Math.min(COMPACT_PANE_WIDTH, Math.max(160, size.width - 48))
          : Math.min(paletteWidth, maxSideWidth),
      }}
    >
      <div className="space-y-1 border-b p-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("processing.modelBuilder.searchTools")}
          aria-label={t("processing.modelBuilder.searchTools")}
          className="h-7 text-xs"
        />
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-6 flex-1 px-1 text-[11px]"
            onClick={() => addNode("input")}
          >
            {t("processing.modelBuilder.addInputNode")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 flex-1 px-1 text-[11px]"
            onClick={() => addNode("output")}
          >
            {t("processing.modelBuilder.addOutputNode")}
          </Button>
        </div>
        <div className="pt-1">
          <div className="flex items-center justify-between pb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("processing.modelBuilder.controlFlow.heading")}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-1">
            <Button
              size="sm"
              variant="outline"
              className="h-6 justify-start px-1.5 text-[10px] truncate"
              onClick={() => addControlFlowNode("iterate-features")}
              title={t("processing.modelBuilder.controlFlow.add.iterateFeaturesTitle")}
            >
              {t("processing.modelBuilder.controlFlow.add.iterateFeatures")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 justify-start px-1.5 text-[10px] truncate"
              onClick={() => addControlFlowNode("iterate-rasters")}
              title={t("processing.modelBuilder.controlFlow.add.iterateRastersTitle")}
            >
              {t("processing.modelBuilder.controlFlow.add.iterateRasters")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 justify-start px-1.5 text-[10px] truncate"
              onClick={() => addControlFlowNode("conditional-switch")}
              title={t("processing.modelBuilder.controlFlow.add.switchTitle")}
            >
              {t("processing.modelBuilder.controlFlow.add.switch")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 justify-start px-1.5 text-[10px] truncate"
              onClick={() => addControlFlowNode("conditional-merge")}
              title={t("processing.modelBuilder.controlFlow.add.mergeTitle")}
            >
              {t("processing.modelBuilder.controlFlow.add.merge")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="col-span-2 h-6 justify-center px-1.5 text-[10px] truncate"
              onClick={() => addControlFlowNode("collect-results")}
              title={t("processing.modelBuilder.controlFlow.add.collectTitle")}
            >
              {t("processing.modelBuilder.controlFlow.add.collect")}
            </Button>
          </div>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1 p-2">
        {catalog.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">
            {t("processing.modelBuilder.loadingTools")}
          </p>
        ) : groups.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">
            {t("processing.modelBuilder.noToolsMatch")}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.group} className="mb-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {translateModelToolGroup(t, group)}
              </p>
              {group.tools.map((tool) => {
                const catalog = modelProviderCatalog(tool.provider);
                const toolMeta = {
                  id: tool.toolId,
                  name: tool.name,
                  description: tool.description,
                };
                const name = translateToolName(t, catalog, toolMeta);
                // `||`, not `??`: a tool with no description (or one whose
                // catalog entry is an empty string) should get the name as
                // its tooltip rather than an empty one.
                const tooltip = translateToolDescription(t, catalog, toolMeta) || name;
                return (
                  // A real button, not a bare draggable div: dragging is the
                  // only other way to add a tool node, so a div here would put
                  // the panel's core interaction out of reach of the keyboard
                  // entirely. Activating it drops the node onto the canvas.
                  <button
                    key={tool.key}
                    type="button"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(TOOL_DRAG_TYPE, tool.key);
                      event.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => addToolAtDefault(tool)}
                    title={tooltip}
                    aria-label={t("processing.modelBuilder.addToolNode", { tool: name })}
                    className="w-full cursor-grab truncate rounded px-1.5 py-1 text-start text-xs hover:bg-accent active:cursor-grabbing"
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </ScrollArea>
    </div>
  );
}
