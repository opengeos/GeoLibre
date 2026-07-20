import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ANNOTATIONS_PLUGIN_ID,
  maplibreAnnotationsPlugin,
  setAnnotationLabels,
} from "../packages/plugins/src/plugins/maplibre-annotations";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

describe("Annotations descriptor", () => {
  it("uses hosted lifecycle, state, and position commands without a native map", () => {
    const invocations: Array<{ command: string; input: unknown }> = [];
    const app = {
      map: {
        invoke: (command: string, input: unknown) => {
          invocations.push({ command, input });
          return true;
        },
      },
    } as unknown as GeoLibreAppAPI;

    maplibreAnnotationsPlugin.activate(app);
    setAnnotationLabels({ toolbar: "Werkzeuge" });
    assert.equal(maplibreAnnotationsPlugin.setMapControlPosition?.(app, "bottom-left"), true);
    maplibreAnnotationsPlugin.deactivate(app);

    assert.deepEqual(
      invocations.map(({ command }) => command),
      [
        "hosted-plugin.activate",
        "hosted-plugin.apply-state",
        "hosted-plugin.set-position",
        "hosted-plugin.deactivate",
      ],
    );
    assert.equal((invocations[0].input as { pluginId: string }).pluginId, ANNOTATIONS_PLUGIN_ID);
  });
});
