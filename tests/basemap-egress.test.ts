import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  BLANK_BASEMAP,
  CHINA_BASEMAPS,
  createEmptyProject,
  DEFAULT_BASEMAP,
  useAppStore,
} from "@geolibre/core";
import { createBasemapEgressTracker } from "../apps/geolibre-desktop/src/lib/basemap-egress";

const AMAP = CHINA_BASEMAPS.find((basemap) => basemap.id === "amap-street")!;

function inbound(styleUrl: string) {
  return createEmptyProject("Host", { basemapStyleUrl: styleUrl });
}

/** The snapshot a bridge would post, built from the store's basemap. */
function outbound() {
  return createEmptyProject("Host", { basemapStyleUrl: useAppStore.getState().basemapStyleUrl });
}

describe("createBasemapEgressTracker", () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
    useAppStore.setState({ regionalBasemapAnswers: {} });
    useAppStore.getState().setRegionalBasemapPolicy("prompt");
  });
  afterEach(() => {
    useAppStore.getState().setRegionalBasemapPolicy("allow");
    useAppStore.getState().newProject();
  });

  it("posts the host's regional basemap back while the fallback is on screen", () => {
    const tracker = createBasemapEgressTracker();
    useAppStore.getState().loadProject(inbound(AMAP.styleUrl));
    tracker.noteInbound(AMAP.styleUrl);
    assert.equal(useAppStore.getState().basemapStyleUrl, DEFAULT_BASEMAP);
    assert.equal(tracker.apply(outbound()).basemapStyleUrl, AMAP.styleUrl);
  });

  it("lets the user's own pick through, even of the default basemap", () => {
    const tracker = createBasemapEgressTracker();
    useAppStore.getState().loadProject(inbound(AMAP.styleUrl));
    tracker.noteInbound(AMAP.styleUrl);
    useAppStore.getState().setBasemapStyleUrl(DEFAULT_BASEMAP);
    assert.equal(tracker.apply(outbound()).basemapStyleUrl, DEFAULT_BASEMAP);
  });

  it("stops substituting once the user answers Load", () => {
    const tracker = createBasemapEgressTracker();
    useAppStore.getState().loadProject(inbound(AMAP.styleUrl));
    tracker.noteInbound(AMAP.styleUrl);
    useAppStore.getState().resolveRegionalBasemapHold(true);
    assert.equal(tracker.apply(outbound()).basemapStyleUrl, AMAP.styleUrl);
    useAppStore.getState().setBasemapStyleUrl(BLANK_BASEMAP);
    assert.equal(tracker.apply(outbound()).basemapStyleUrl, BLANK_BASEMAP);
  });

  it("keeps a blocked session basemap for peers", () => {
    useAppStore.getState().setRegionalBasemapPolicy("block");
    const tracker = createBasemapEgressTracker();
    useAppStore.getState().loadProject(inbound(AMAP.styleUrl), null, { trustBasemap: true });
    tracker.noteInbound(AMAP.styleUrl);
    assert.equal(useAppStore.getState().basemapStyleUrl, DEFAULT_BASEMAP);
    assert.equal(tracker.apply(outbound()).basemapStyleUrl, AMAP.styleUrl);
  });

  it("forgets the withheld basemap when another project is opened, if asked to", () => {
    const tracker = createBasemapEgressTracker({ forgetOnProjectSwitch: true });
    useAppStore.getState().loadProject(inbound(AMAP.styleUrl));
    tracker.noteInbound(AMAP.styleUrl);
    assert.equal(tracker.apply(outbound()).basemapStyleUrl, AMAP.styleUrl);
    // A local open, not through the bridge, so the tracker is not told.
    useAppStore.getState().loadProject(inbound(DEFAULT_BASEMAP));
    assert.equal(tracker.apply(outbound()).basemapStyleUrl, DEFAULT_BASEMAP);
    assert.equal(tracker.withheldStyleUrl(), null);
  });

  it("does nothing for an applied or non-regional basemap, or after reset", () => {
    const tracker = createBasemapEgressTracker();
    useAppStore.getState().loadProject(inbound(BLANK_BASEMAP));
    tracker.noteInbound(BLANK_BASEMAP);
    assert.equal(tracker.apply(outbound()).basemapStyleUrl, BLANK_BASEMAP);

    useAppStore.getState().loadProject(inbound(AMAP.styleUrl), null, { trustBasemap: true });
    tracker.noteInbound(AMAP.styleUrl);
    assert.equal(tracker.apply(inbound(DEFAULT_BASEMAP)).basemapStyleUrl, DEFAULT_BASEMAP);

    useAppStore.getState().loadProject(inbound(AMAP.styleUrl));
    tracker.noteInbound(AMAP.styleUrl);
    tracker.reset();
    assert.equal(tracker.apply(outbound()).basemapStyleUrl, DEFAULT_BASEMAP);
  });
});
