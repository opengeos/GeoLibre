/**
 * ArcGIS I3S Building Scene Layers (issue #3341).
 *
 * A Building Scene Layer (`layerType: "Building"`) is not drawable itself: it
 * is a tree of sublayers at `.../layers/<n>/sublayers/<id>`. Its top level
 * usually holds an `Overview` 3DObject sublayer (the building shell, shown by
 * default) and a `FullModel` group whose children are the disciplines
 * (Architectural, Structural, Mechanical, Electrical, Piping, ...), each a
 * group of category sublayers (Walls, Windows, Doors, Ducts, ...), every one
 * of them an ordinary 3DObject layer the I3S mesh pipeline can draw.
 *
 * GeoLibre keeps the tree, with a visibility per node, on the layer as
 * `metadata.i3sBuilding`, so the choice saves with the project, and draws one
 * deck.gl `Tile3DLayer` per visible 3DObject leaf.
 */

import type { I3sBuildingNode, I3sBuildingState } from "@geolibre/core";

export {
  visibleI3sBuildingSublayers,
  type I3sBuildingNode,
  type I3sBuildingState,
} from "@geolibre/core";

/** A raw sublayer entry from the service's layer document. */
interface RawSublayer {
  id?: unknown;
  name?: unknown;
  alias?: unknown;
  modelName?: unknown;
  layerType?: unknown;
  visibility?: unknown;
  sublayers?: unknown;
}

function toNode(raw: RawSublayer): I3sBuildingNode | null {
  if (typeof raw.id !== "number" || !Number.isFinite(raw.id)) return null;
  const name =
    typeof raw.alias === "string" && raw.alias
      ? raw.alias
      : typeof raw.name === "string"
        ? raw.name
        : String(raw.id);
  const children = Array.isArray(raw.sublayers)
    ? (raw.sublayers as RawSublayer[]).map(toNode).filter((node): node is I3sBuildingNode => !!node)
    : undefined;
  return {
    id: raw.id,
    name,
    ...(typeof raw.modelName === "string" ? { modelName: raw.modelName } : {}),
    layerType: typeof raw.layerType === "string" ? raw.layerType : "group",
    // A Full Model shown as a whole is what the user asks for by choosing it;
    // the service's own visibility flags (often everything hidden under a
    // hidden Full Model) would otherwise draw nothing.
    visible: true,
    ...(children && children.length > 0 ? { children } : {}),
  };
}

/**
 * Whether a layer document is a Building Scene Layer.
 *
 * @param doc - The service's `.../layers/<n>` JSON.
 * @returns True for `layerType: "Building"`.
 */
export function isI3sBuildingLayerDocument(doc: unknown): boolean {
  return (doc as { layerType?: unknown } | null)?.layerType === "Building";
}

/**
 * Read a Building Scene Layer's sublayer tree into the state GeoLibre keeps.
 *
 * @param doc - The service's `.../layers/<n>` JSON for a Building layer.
 * @returns The state: Overview mode when the service has an Overview sublayer.
 */
export function parseI3sBuildingLayer(doc: unknown): I3sBuildingState {
  const top = Array.isArray((doc as { sublayers?: unknown })?.sublayers)
    ? ((doc as { sublayers: RawSublayer[] }).sublayers
        .map(toNode)
        .filter(Boolean) as I3sBuildingNode[])
    : [];
  const overview = top.find((node) => node.modelName === "Overview" && node.layerType !== "group");
  const fullModel = top.find(
    (node) => node.modelName === "FullModel" && node.layerType === "group",
  );
  const disciplines = fullModel?.children ?? top.filter((node) => node !== overview);
  return {
    mode: overview ? "overview" : "full",
    overviewId: overview?.id ?? null,
    disciplines,
  };
}

/**
 * Set one node's visibility (a discipline, or a category inside one).
 *
 * @param state - The current state.
 * @param id - The node to change.
 * @param visible - Its new visibility.
 * @returns A new state; the input is not changed.
 */
export function setI3sBuildingNodeVisible(
  state: I3sBuildingState,
  id: number,
  visible: boolean,
): I3sBuildingState {
  const update = (nodes: readonly I3sBuildingNode[]): I3sBuildingNode[] =>
    nodes.map((node) =>
      node.id === id
        ? { ...node, visible }
        : node.children
          ? { ...node, children: update(node.children) }
          : node,
    );
  return { ...state, disciplines: update(state.disciplines) };
}

/**
 * A Scene Layer document path: `.../SceneServer/layers/<n>`, optionally a
 * Building Scene Layer's `/sublayers/<m>`, with nothing after it.
 */
export const I3S_LAYER_DOCUMENT_RE = /\/SceneServer\/layers\/\d+(?:\/sublayers\/\d+)?\/?$/i;

/**
 * Split a URL at its first `?`: the path, and the query (without the `?`) or
 * `""`. A `#fragment` is dropped first; it never reaches the server.
 */
function splitQuery(url: string): [string, string] {
  const hash = url.indexOf("#");
  if (hash >= 0) url = url.slice(0, hash);
  const at = url.indexOf("?");
  return at < 0 ? [url, ""] : [url.slice(0, at), url.slice(at + 1)];
}

/**
 * A sublayer's URL under a Building Scene Layer URL, keeping any query
 * (a token) on the end.
 *
 * @param layerUrl - `.../SceneServer/layers/<n>`, optionally with a query.
 * @param sublayerId - The sublayer id.
 * @returns `.../SceneServer/layers/<n>/sublayers/<id>`.
 */
export function i3sBuildingSublayerUrl(layerUrl: string, sublayerId: number): string {
  const [path, query] = splitQuery(layerUrl);
  const base = path.replace(/\/+$/, "");
  return `${base}/sublayers/${sublayerId}${query ? `?${query}` : ""}`;
}

/**
 * The layer document URL to probe for an I3S layer URL: the URL itself when it
 * names `.../layers/<n>`, else `.../SceneServer/layers/0` for a service root.
 *
 * @param url - The URL the user added.
 * @returns The layer document URL, or `null` when it cannot be derived.
 */
export function i3sLayerDocumentUrl(url: string): string | null {
  const [path, query] = splitQuery(url.trim());
  const suffix = query ? `?${query}` : "";
  if (I3S_LAYER_DOCUMENT_RE.test(path)) {
    return path.replace(/\/+$/, "") + suffix;
  }
  if (/\/SceneServer\/?$/i.test(path)) return path.replace(/\/+$/, "") + "/layers/0" + suffix;
  return null;
}
