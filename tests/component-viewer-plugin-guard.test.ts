import "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { LayoutOptions } from "../apps/geolibre-desktop/src/hooks/useLayoutOptions";
import {
  getGeoEditorOptions,
  setGeoEditorFileTools,
} from "../packages/plugins/src/plugins/maplibre-geo-editor";

const { useViewerPluginGuard } =
  await import("../apps/geolibre-desktop/src/hooks/desktop-shell/useViewerPluginGuard");

describe("useViewerPluginGuard file tools", () => {
  it("drops the editor's file buttons during render, before any effect can construct it", () => {
    // `renderToString` runs the render phase but never effects, so a flag that
    // is already set afterwards was set by the render itself. Every path that
    // constructs the editor (`?plugin=geo-editor`, project restore) runs from
    // an effect, which is later than that.
    const render = (viewer: boolean) =>
      renderToString(
        createElement(() => {
          useViewerPluginGuard({ viewer, viewerDrawing: true } as LayoutOptions, { current: null });
          return null;
        }),
      );
    try {
      setGeoEditorFileTools(true);
      render(true);
      assert.deepEqual(getGeoEditorOptions(null).fileModes, []);
      render(false);
      assert.deepEqual(getGeoEditorOptions(null).fileModes, ["open", "save"]);
    } finally {
      setGeoEditorFileTools(true);
    }
  });
});
