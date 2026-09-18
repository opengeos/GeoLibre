import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { VectorControl } from "maplibre-gl-vector";
import { RasterControl } from "maplibre-gl-raster";

// Exercise the installed plugins' positioning methods: Mapbox uses different
// corner classes, and a wrong right-hand anchor puts these panels under Layers.
for (const Control of [VectorControl, RasterControl]) {
  describe(`${Control.name} panel positioning`, () => {
    for (const engine of ["maplibregl", "mapboxgl"]) {
      for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
        it(`anchors inside the map at ${engine} ${corner}`, () => {
          const { document } = parseHTML("<html><body></body></html>");
          const map = document.createElement("div");
          const parent = document.createElement("div");
          parent.className = `${engine}-ctrl-${corner}`;
          const container = document.createElement("div");
          const button = document.createElement("button");
          button.className = "vector-control-toggle mlr-control-toggle";
          container.append(button);
          parent.append(container);
          map.append(parent);
          const panel = document.createElement("div");
          map.append(panel);
          const left = corner.endsWith("left");
          const top = corner.startsWith("top");
          map.getBoundingClientRect = () =>
            ({
              left: 350,
              right: 1350,
              top: 40,
              bottom: 840,
              width: 1000,
              height: 800,
            }) as DOMRect;
          button.getBoundingClientRect = () =>
            ({
              left: left ? 360 : 1310,
              right: left ? 390 : 1340,
              top: top ? 50 : 800,
              bottom: top ? 80 : 830,
              width: 30,
              height: 30,
            }) as DOMRect;
          const control = Object.assign(Object.create(Control.prototype), {
            _container: container,
            _panel: panel,
            _mapContainer: map,
            _userWidth: null,
            _userHeight: null,
          });
          control._updatePanelPosition();
          assert.equal(panel.style[left ? "left" : "right"], "10px");
          assert.equal(panel.style[left ? "right" : "left"], "");
          assert.equal(panel.style[top ? "top" : "bottom"], "45px");
          assert.equal(panel.style[top ? "bottom" : "top"], "");
        });
      }
    }
  });
}
