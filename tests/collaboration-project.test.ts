import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreProject, ProjectPluginState } from "@geolibre/core";
import { mergeInboundCollaborationProject } from "../apps/geolibre-desktop/src/lib/collaboration-project";

const view = { center: [1, 2] as [number, number], zoom: 3, bearing: 0, pitch: 0 };

describe("inbound collaboration project", () => {
  it("keeps local plugin activation instead of applying a peer's stale state", () => {
    const localPlugins: ProjectPluginState = {
      activePluginIds: ["maplibre-gl-annotate-geocodes"],
      settings: { "maplibre-gl-annotate-geocodes": { collapsed: false } },
      mapControlPositions: {},
      manifestUrls: [],
    };
    const incoming = {
      version: 1,
      name: "Peer",
      mapView: view,
      layers: [],
      plugins: {
        activePluginIds: [],
        settings: {},
        mapControlPositions: {},
        manifestUrls: [],
      },
    } as GeoLibreProject;

    const merged = mergeInboundCollaborationProject(incoming, view, localPlugins);
    assert.equal(merged.plugins, localPlugins);
    assert.deepEqual(merged.plugins?.activePluginIds, ["maplibre-gl-annotate-geocodes"]);
  });

  it("does not install or activate a plugin merely because a peer has it", () => {
    const incoming = {
      version: 1,
      name: "Peer",
      mapView: view,
      layers: [],
      plugins: {
        activePluginIds: ["maplibre-gl-annotate-geocodes"],
        settings: {},
        mapControlPositions: {},
        manifestUrls: [],
      },
    } as GeoLibreProject;

    const merged = mergeInboundCollaborationProject(incoming, view, null);
    assert.equal(merged.plugins, undefined);
  });
});
