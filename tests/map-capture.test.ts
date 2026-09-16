import assert from "node:assert/strict";
import { test } from "node:test";
import { captureEngineImage } from "../packages/map/src/map-capture";
import type { MapEngine } from "../packages/map/src/map-engine";

test("capture reports a failed visible layer instead of exporting partial pixels", async () => {
  const engine = {
    getRenderStatus: () => ({ pending: [], errors: ["Buildings: failed to load"] }),
  };
  await assert.rejects(captureEngineImage(engine as unknown as MapEngine), /Buildings: failed/);
});

test("destroying the engine while capture waits rejects and stops polling", async () => {
  let polls = 0;
  const engine = {
    getRenderStatus: () =>
      ++polls === 1
        ? { pending: ["Tiles"], errors: [] }
        : { pending: [], errors: ["The globe is not available"] },
  };
  await assert.rejects(captureEngineImage(engine as unknown as MapEngine), /not available/);
  assert.equal(polls, 2);
});

test("captures only the active overview or detailed map, including after overview disposal", async () => {
  const { parseHTML } = await import("linkedom");
  const { isActiveMapCanvas, getEqualEarthCapture, registerEqualEarthCapture } =
    await import("../packages/map/src/map-capture");
  const { document } = parseHTML(
    '<div id="map"><canvas id="native"></canvas><div class="geolibre-equal-earth-overview"><canvas id="overview"></canvas></div></div>',
  );
  const container = document.getElementById("map")!;
  const native = document.getElementById("native") as HTMLCanvasElement;
  const overview = document.getElementById("overview") as HTMLCanvasElement;
  const surface = { redraw() {}, unproject: () => ({ lng: 0, lat: 0 }) };
  registerEqualEarthCapture(container, surface);
  container.classList.add("geolibre-equal-earth-active");
  assert.equal(isActiveMapCanvas(native, container), false);
  assert.equal(isActiveMapCanvas(overview, container), true);
  assert.equal(getEqualEarthCapture(container), surface);
  container.classList.remove("geolibre-equal-earth-active");
  overview.parentElement!.setAttribute("hidden", "");
  assert.equal(isActiveMapCanvas(native, container), true);
  assert.equal(isActiveMapCanvas(overview, container), false);
  assert.equal(getEqualEarthCapture(container), undefined);
  registerEqualEarthCapture(container, null);
  container.classList.add("geolibre-equal-earth-active");
  assert.equal(getEqualEarthCapture(container), undefined);
});
