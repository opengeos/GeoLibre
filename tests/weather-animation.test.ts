import assert from "node:assert/strict";
import { it } from "node:test";
import { cloudsAnimation, precipitationAnimation } from "../packages/plugins/src/weather-animation";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

it("keeps unloaded weather inert and connects an existing observer when a public SDK provider loads", async () => {
  const inactive = { labels: [], index: 0, playing: false, active: false };
  assert.deepEqual(cloudsAnimation.getState(), inactive);
  assert.deepEqual(precipitationAnimation.getState(), inactive);
  cloudsAnimation.setFrame(3);
  cloudsAnimation.togglePlaying();
  assert.deepEqual(cloudsAnimation.getState(), inactive);
  let updates = 0;
  const unsubscribe = cloudsAnimation.subscribe(() => updates++);
  const native = await import("../packages/plugins/src/plugins/maplibre-clouds");
  const app = { getMap: () => null } as unknown as GeoLibreAppAPI;
  try {
    assert.equal(updates, 1);
    assert.equal(await native.maplibreCloudsPlugin.activate(app), true);
    assert.equal(cloudsAnimation.getState().active, true);
    assert.equal(cloudsAnimation.getState().labels.length, 10);
    assert.deepEqual(cloudsAnimation.getState(), native.getCloudsAnimationState());
    cloudsAnimation.setFrame(0);
    assert.equal(native.getCloudsAnimationState().index, 0);
    cloudsAnimation.togglePlaying();
    assert.equal(native.getCloudsAnimationState().playing, true);
    cloudsAnimation.togglePlaying();
    assert.equal(native.getCloudsAnimationState().playing, false);
    assert.ok(updates > 3);
    const beforeUnsubscribe = updates;
    unsubscribe();
    native.maplibreCloudsPlugin.deactivate(app);
    assert.equal(updates, beforeUnsubscribe);
    assert.deepEqual(cloudsAnimation.getState(), inactive);
    assert.deepEqual(precipitationAnimation.getState(), inactive);
  } finally {
    unsubscribe();
    native.maplibreCloudsPlugin.deactivate(app);
  }
});
