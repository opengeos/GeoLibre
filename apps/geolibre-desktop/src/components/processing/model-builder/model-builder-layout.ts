// Graph card geometry for the Model Builder canvas: card sizes, port positions and node ids.

import type { ModelGraphNode, ModelGraphNodeKind } from "@geolibre/core";
import { portsFor, type ModelToolDescriptor } from "@geolibre/processing";
import { NODE_HEIGHT, NODE_WIDTH } from "../../../lib/model-graph-edit";

/** A best-effort unique id (the webview always has crypto.randomUUID). */
export function createId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}`;
}

/**
 * Vertical room the provider line and the tool name take on a card. Measured
 * against the rendered header (a 10px uppercase line over a 12px title, inside
 * the card's 8px padding), so the first port row starts below it rather than
 * on top of the name.
 */
const CARD_HEADER_HEIGHT = 40;

/** Height of one labelled port row. */
export const PORT_ROW_HEIGHT = 18;

/**
 * Card geometry for one node.
 *
 * Every input port on a *tool* is labelled, including a lone one: a bare dot
 * says a connection goes here but not what belongs on it, so a single-input
 * tool left the user guessing what it wanted just as a multi-input one left
 * them guessing which dot was which. Cards grow to fit the rows when they need
 * to; one input row still fits the compact card.
 *
 * The synthetic `input` and `output` nodes are excluded: their single port
 * carries the node's own kind as its name, so labelling it would print
 * "Output" under a card already headed OUTPUT. Output ports are labelled only
 * when a tool has several, since one result port needs no telling apart.
 */
export function cardLayout(
  ports: {
    inputs: { id: string; label: string }[];
    outputs: { id: string; label: string }[];
  },
  kind: ModelGraphNodeKind,
): { height: number; labelIn: boolean; labelOut: boolean; band: PortBand } {
  const labelIn = kind === "tool" && ports.inputs.length > 0;
  const labelOut = ports.outputs.length > 1;
  const rows = Math.max(ports.inputs.length, ports.outputs.length);
  // A labelled card is always a little taller than a bare one: at the compact
  // height a single row's text sits hard against the title above and the card
  // edge below. The synthetic input/output cards carry no port label, but
  // sizing them bare would leave them visibly shorter than every tool card
  // beside them, so they take the height of a one-row labelled tool and a
  // chain lines up.
  const height =
    labelIn || labelOut || kind !== "tool"
      ? Math.max(NODE_HEIGHT + 6, CARD_HEADER_HEIGHT + Math.max(rows, 1) * PORT_ROW_HEIGHT + 8)
      : NODE_HEIGHT;
  // Both sides share one vertical band. A labelled side fills it row by row; an
  // unlabelled side spreads its dots down the same band rather than down the
  // whole card, so the lone output of a labelled tool still lines up with its
  // inputs instead of floating up next to the header.
  const band: PortBand =
    labelIn || labelOut
      ? { top: CARD_HEADER_HEIGHT, height: rows * PORT_ROW_HEIGHT }
      : { top: 0, height };
  return { height, labelIn, labelOut, band };
}

/** The vertical span of a card given over to its port connectors. */
interface PortBand {
  top: number;
  height: number;
}

/**
 * Where one port's connector sits.
 *
 * Labelled ports stack in rows under the header so each dot lines up with its
 * name; an unlabelled side spreads its single dot down the middle of the card
 * as it always did.
 */
export function portPosition(
  node: ModelGraphNode,
  index: number,
  count: number,
  side: "in" | "out",
  band: PortBand = { top: 0, height: NODE_HEIGHT },
  labelled = false,
): { x: number; y: number } {
  const x = side === "in" ? node.x : node.x + NODE_WIDTH;
  if (labelled) {
    return {
      x,
      y: node.y + band.top + PORT_ROW_HEIGHT * index + PORT_ROW_HEIGHT / 2,
    };
  }
  const spacing = band.height / (count + 1);
  return { x, y: node.y + band.top + spacing * (index + 1) };
}

/** The ports a node exposes, mirroring the graph engine's own rule. */
export function portsOf(
  node: ModelGraphNode,
  descriptor: ModelToolDescriptor | undefined,
): {
  inputs: { id: string; label: string }[];
  outputs: { id: string; label: string }[];
} {
  return portsFor(node, descriptor);
}
