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
