/**
 * The saved state of an ArcGIS I3S Building Scene Layer (issue #3341), shared
 * by the deck.gl overlay (`@geolibre/plugins`) and the globe
 * (`@geolibre/map`'s Cesium sync), so both draw the same sublayers.
 *
 * The plugins' `i3s-building.ts` parses the service's sublayer tree into this
 * shape and stores it as `metadata.i3sBuilding`.
 */

/** One node of a Building Scene Layer's sublayer tree. */
export interface I3sBuildingNode {
  id: number;
  name: string;
  /** The I3S model name: `FullModel`, `Overview`, a discipline or category name. */
  modelName?: string;
  /** `group` for a discipline or folder; `3DObject` (or another type) for a drawable leaf. */
  layerType: string;
  visible: boolean;
  children?: I3sBuildingNode[];
}

/** What `metadata.i3sBuilding` holds for a Building Scene Layer. */
export interface I3sBuildingState {
  /** `overview` draws the Overview sublayer; `full` draws the visible Full Model leaves. */
  mode: "overview" | "full";
  /** The Overview sublayer's id, or `null` when the service has none. */
  overviewId: number | null;
  /** The Full Model's children (disciplines), or every top-level sublayer when there is no Full Model group. */
  disciplines: I3sBuildingNode[];
}

/** The drawable leaves under the given nodes whose whole branch is visible. */
function visibleLeaves(nodes: readonly I3sBuildingNode[], out: number[]): number[] {
  for (const node of nodes) {
    if (!node.visible) continue;
    if (node.children?.length) visibleLeaves(node.children, out);
    else if (node.layerType === "3DObject") out.push(node.id);
  }
  return out;
}

/**
 * The sublayer ids to draw for a Building Scene Layer.
 *
 * @param state - The layer's `metadata.i3sBuilding`.
 * @returns The Overview id in Overview mode; otherwise every visible 3DObject leaf.
 */
export function visibleI3sBuildingSublayers(state: I3sBuildingState): number[] {
  if (state.mode === "overview" && state.overviewId !== null) return [state.overviewId];
  return visibleLeaves(state.disciplines, []);
}

/**
 * How far to lower an I3S scene layer onto a map or globe without terrain,
 * in metres (issue #3374). Shared by the 2D overlay and the globe so the rule
 * cannot drift between them.
 *
 * Scene layers store absolute elevations. Without terrain the ground is at
 * 0 m, so a layer whose reported lowest elevation (`fullExtent.zmin`) is above
 * 0 m is lowered by it; one that already reaches 0 m or below (a coastal city)
 * is left alone. With terrain the absolute heights are kept.
 *
 * @param baseElevation - The layer's `fullExtent.zmin`, if known.
 * @param terrain - Whether the map or globe draws 3D terrain.
 * @returns The offset (0 or negative).
 */
export function i3sGroundOffset(baseElevation: unknown, terrain: boolean): number {
  return !terrain &&
    typeof baseElevation === "number" &&
    Number.isFinite(baseElevation) &&
    baseElevation > 0
    ? -baseElevation
    : 0;
}

/**
 * Carry a saved Building selection onto a freshly parsed sublayer tree.
 *
 * Re-probing a layer refreshes its tree from the service. The saved mode and
 * each node's visibility are kept where the node still exists (matched by id);
 * a node the service added takes its parsed default, and one it removed is
 * dropped, so the renderer never asks for a sublayer that is gone.
 *
 * @param fresh - The tree parsed from the service now.
 * @param saved - The selection saved on the layer.
 * @returns The fresh tree with the saved choices applied.
 */
export function mergeI3sBuildingSelection(
  fresh: I3sBuildingState,
  saved: I3sBuildingState,
): I3sBuildingState {
  const visibility = new Map<number, boolean>();
  const collect = (nodes: readonly I3sBuildingNode[]) => {
    for (const node of nodes) {
      visibility.set(node.id, node.visible);
      if (node.children) collect(node.children);
    }
  };
  collect(saved.disciplines);
  const apply = (nodes: readonly I3sBuildingNode[]): I3sBuildingNode[] =>
    nodes.map((node) => ({
      ...node,
      visible: visibility.get(node.id) ?? node.visible,
      ...(node.children ? { children: apply(node.children) } : {}),
    }));
  return {
    ...fresh,
    mode: saved.mode === "overview" && fresh.overviewId === null ? "full" : saved.mode,
    disciplines: apply(fresh.disciplines),
  };
}
