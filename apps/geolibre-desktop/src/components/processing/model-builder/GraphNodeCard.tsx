// One node card on the Model Builder canvas.

import type { GeoLibreLayer, ModelGraphNode } from "@geolibre/core";
import type { ModelToolDescriptor } from "@geolibre/processing";
import { cn } from "@geolibre/ui";
import { Fragment, memo, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { NODE_WIDTH } from "../../../lib/model-graph-edit";
import { PORT_ROW_HEIGHT, cardLayout, portPosition, portsOf } from "./model-builder-layout";
import { CONTROL_FLOW_TITLE_KEYS, descriptorName, portLabel } from "./model-builder-labels";

/**
 * One draggable card on the canvas.
 *
 * Memoized because a node drag commits a new graph object on every animation
 * frame: without this, every card on the canvas re-renders for a move that
 * only changed one of them. Its handler props are all `useCallback`-stable, so
 * only the moved card's `node` identity actually changes.
 */
export const GraphNodeCard = memo(function GraphNodeCard({
  node,
  descriptor,
  layers,
  selected,
  status,
  hasIssue,
  armedPortId,
  onSelect,
  onPointerDown,
  onPortPointerDown,
  onPortActivate,
}: {
  node: ModelGraphNode;
  descriptor: ModelToolDescriptor | undefined;
  layers: GeoLibreLayer[];
  selected: boolean;
  status?: "running" | "done" | "error" | "skipped";
  hasIssue: boolean;
  /** The output port on this node armed for a keyboard connection, if any. */
  armedPortId?: string;
  onSelect: (nodeId: string) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, node: ModelGraphNode) => void;
  onPortPointerDown: (
    event: ReactPointerEvent<HTMLButtonElement>,
    nodeId: string,
    portId: string,
  ) => void;
  onPortActivate: (side: "in" | "out", nodeId: string, portId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const ports = portsOf(node, descriptor);
  const layout = cardLayout(ports, node.kind);

  const controlFlowTitleKey = CONTROL_FLOW_TITLE_KEYS[node.kind];
  const isControlFlow = controlFlowTitleKey !== undefined;

  const title =
    node.kind === "input"
      ? (layers.find((layer) => layer.id === node.layerId)?.name ??
        t("processing.modelBuilder.inputNode"))
      : node.kind === "output"
        ? node.name?.trim() || t("processing.modelBuilder.outputNode")
        : isControlFlow
          ? t(controlFlowTitleKey)
          : descriptorName(t, descriptor, node.toolId ?? "");

  return (
    // Focusable with a role, so the card can be reached and selected from the
    // keyboard; without it selecting a node (and so editing its parameters in
    // the inspector) needed a pointer. Dragging stays pointer-only — a card's
    // position is presentation, not part of the model.
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={title}
      onPointerDown={(event) => onPointerDown(event, node)}
      onKeyDown={(event) => {
        // Only the card's own activation. A keydown on one of the port buttons
        // bubbles up here, and preventDefault() on that would stop the browser
        // synthesizing the port's `click` — which is the whole keyboard wiring
        // path.
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect(node.id);
      }}
      style={{
        left: node.x,
        top: node.y,
        width: NODE_WIDTH,
        height: layout.height,
      }}
      className={cn(
        "absolute cursor-grab select-none border p-2 shadow-sm active:cursor-grabbing",
        // A tool is a square-cornered card (control-flow nodes too, tinted
        // amber); the model's own inputs and outputs are rounded and tinted, so
        // the data flowing in and out reads apart from the processing between
        // it at a glance — the same split ArcGIS ModelBuilder and QGIS draw as
        // ovals versus rectangles. Safe for exactly these two kinds: each has a
        // single, vertically centred port, so no port dot ever lands on the
        // rounded part of the edge.
        isControlFlow
          ? "rounded-md border-amber-500/40 bg-amber-500/10"
          : node.kind === "tool"
            ? "rounded-md bg-card"
            : "rounded-xl border-primary/40 bg-primary/10",
        selected && "border-primary ring-2 ring-primary/30",
        hasIssue && !selected && "border-destructive",
        status === "running" && "ring-2 ring-primary",
        status === "done" && "border-primary/60",
        status === "skipped" && "opacity-60 border-muted-foreground/30 bg-muted/40",
        status === "error" && "border-destructive ring-2 ring-destructive/40",
      )}
    >
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {node.kind === "tool"
          ? (node.provider ?? "")
          : node.kind === "input"
            ? t("processing.modelBuilder.inputNode")
            : node.kind === "output"
              ? t("processing.modelBuilder.outputNode")
              : t("processing.modelBuilder.controlFlow.heading")}
      </p>
      <p className="truncate text-xs font-medium" title={title}>
        {title}
      </p>

      {ports.inputs.map((port, index) => {
        const at = portPosition(
          node,
          index,
          ports.inputs.length,
          "in",
          layout.band,
          layout.labelIn,
        );
        return (
          <Fragment key={port.id}>
            <button
              type="button"
              data-port="in"
              data-node-id={node.id}
              data-port-id={port.id}
              title={portLabel(t, port.label)}
              aria-label={t("processing.modelBuilder.inputPort", {
                port: portLabel(t, port.label),
              })}
              onClick={() => onPortActivate("in", node.id, port.id)}
              style={{ left: -6, top: at.y - node.y - 5 }}
              className="absolute h-2.5 w-2.5 cursor-pointer rounded-full border border-primary bg-background"
            />
            {/* The name of the port this dot belongs to, so a multi-input tool
                says which input is which without hovering each dot. */}
            {layout.labelIn && (
              <span
                aria-hidden="true"
                style={{
                  left: 6,
                  top: at.y - node.y - PORT_ROW_HEIGHT / 2,
                  height: PORT_ROW_HEIGHT,
                  maxWidth: NODE_WIDTH - 24,
                }}
                className="pointer-events-none absolute flex items-center truncate text-[9px] leading-none text-muted-foreground"
              >
                {portLabel(t, port.label)}
              </span>
            )}
          </Fragment>
        );
      })}
      {ports.outputs.map((port, index) => {
        const at = portPosition(
          node,
          index,
          ports.outputs.length,
          "out",
          layout.band,
          layout.labelOut,
        );
        return (
          <Fragment key={port.id}>
            <button
              type="button"
              data-port="out"
              data-node-id={node.id}
              data-port-id={port.id}
              title={portLabel(t, port.label)}
              aria-label={t("processing.modelBuilder.outputPort", {
                port: portLabel(t, port.label),
              })}
              aria-pressed={armedPortId === port.id}
              // Pointer users drag; keyboard users activate, which fires `click`
              // and never `pointerdown`. Both paths end in connectPorts.
              onPointerDown={(event) => onPortPointerDown(event, node.id, port.id)}
              onClick={(event) => {
                // A pointer drag ends in its own `pointerup` handler and then
                // fires a click here too, which would arm the port it just wired.
                if (event.detail !== 0) return;
                onPortActivate("out", node.id, port.id);
              }}
              style={{ right: -6, top: at.y - node.y - 5 }}
              className={cn(
                "absolute h-2.5 w-2.5 cursor-crosshair rounded-full border border-primary bg-primary",
                armedPortId === port.id && "ring-2 ring-primary ring-offset-1",
              )}
            />
            {layout.labelOut && (
              <span
                aria-hidden="true"
                style={{
                  right: 6,
                  top: at.y - node.y - PORT_ROW_HEIGHT / 2,
                  height: PORT_ROW_HEIGHT,
                  maxWidth: NODE_WIDTH - 24,
                }}
                className="pointer-events-none absolute flex items-center truncate text-[9px] leading-none text-muted-foreground"
              >
                {portLabel(t, port.label)}
              </span>
            )}
          </Fragment>
        );
      })}
    </div>
  );
});
