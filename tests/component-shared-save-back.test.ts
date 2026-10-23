import { act, cleanup, mockFetch, render, resetStores, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import { createEmptyProject, parseProject, serializeProject } from "@geolibre/core";
import { geojsonLayer } from "./helpers/layer-fixtures";
import type { ProjectFileActions } from "../apps/geolibre-desktop/src/hooks/useProjectFileActions";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { useProjectFileActions } =
  await import("../apps/geolibre-desktop/src/hooks/useProjectFileActions");
const { DEFAULT_SHARE_BASE_URL } = await import("../apps/geolibre-desktop/src/lib/share-geolibre");

const RAW_URL = `${DEFAULT_SHARE_BASE_URL}/owner/team-map.geolibre.json`;
const CONTENT_URL = `${DEFAULT_SHARE_BASE_URL}/api/projects/project-1/content`;

/** Render the hook and hand back its latest actions. */
function renderActions(): () => ProjectFileActions {
  let actions: ProjectFileActions | null = null;
  function Harness() {
    actions = useProjectFileActions({ current: null });
    return null;
  }
  render(createElement(Harness));
  return () => {
    assert.ok(actions, "hook rendered");
    return actions;
  };
}

afterEach(() => {
  cleanup();
  resetStores();
});

describe("saving back to an editable shared project", () => {
  it("uploads a local-file layer's features instead of a path on the saver's disk", async () => {
    const uploads: string[] = [];
    mockFetch(async (input, init) => {
      const url = String(input);
      if (url === RAW_URL) {
        return new Response(serializeProject({ ...createEmptyProject(), name: "Team map" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === CONTENT_URL && init?.method === "PUT") {
        uploads.push(JSON.parse(String(init.body)).content);
        return new Response(JSON.stringify({ project: { versionCount: 2 }, version: 2 }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new TypeError(`unexpected request ${url}`);
    });
    const actions = renderActions();

    await act(() =>
      actions().openProjectFromShareUrl(RAW_URL, {
        authToken: "glb_member",
        remoteProject: {
          id: "project-1",
          versionCount: 1,
          canEdit: true,
          token: "glb_member",
          baseUrl: DEFAULT_SHARE_BASE_URL,
        },
      }),
    );
    // A desktop drag-drop keeps the file's absolute path and flags the layer so
    // a local save can reference the file instead of embedding its features.
    act(() =>
      useAppStore.setState((state) => ({
        layers: [
          ...state.layers,
          geojsonLayer({
            id: "dropped",
            sourcePath: "/home/saver/data/wells.geojson",
            metadata: { localFileReloadable: true },
            geojson: {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  properties: { name: "well" },
                  geometry: { type: "Point", coordinates: [10, 50] },
                },
              ],
            },
          }),
        ],
      })),
    );

    let saved = false;
    await act(async () => {
      saved = await actions().handleSave();
    });

    assert.equal(saved, true);
    assert.equal(actions().embedVectorDataPrompt, null);
    assert.equal(actions().credentialStripPrompt, null);
    assert.equal(uploads.length, 1);
    const layer = parseProject(uploads[0]).layers.find((item) => item.id === "dropped");
    assert.ok(layer, "the dropped layer is uploaded");
    assert.equal(layer.metadata.localFileReloadable, undefined);
    assert.deepEqual(
      layer.geojson?.features.map((feature) => feature.properties?.name),
      ["well"],
    );
  });
});
