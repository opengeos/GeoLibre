import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  BLANK_BASEMAP,
  CHINA_BASEMAPS,
  createEmptyProject,
  DEFAULT_BASEMAP,
  gateRegionalBasemap,
  clearHistory,
  REGIONAL_BASEMAP_SENTINEL_PREFIX,
  redo,
  undo,
  useAppStore,
} from "@geolibre/core";
import {
  policyEnvOverlay,
  setDeploymentPolicy,
} from "../apps/geolibre-desktop/src/lib/deployment-env";
import {
  DISABLE_REGIONAL_BASEMAPS_ENV,
  regionalBasemapsDisabled,
  resolveRegionalBasemapPolicy,
} from "../apps/geolibre-desktop/src/lib/regional-basemap-policy";

// Read before any test changes it: a fresh store must not gate anything.
const INITIAL_POLICY = useAppStore.getState().regionalBasemapPolicy;

const AMAP = CHINA_BASEMAPS.find((basemap) => basemap.id === "amap-street")!;
const TENCENT = CHINA_BASEMAPS.find((basemap) => basemap.id === "tencent-street")!;

function projectWith(styleUrl: string) {
  return createEmptyProject("Regional", { basemapStyleUrl: styleUrl });
}

describe("gateRegionalBasemap", () => {
  it("passes non-regional and unknown regional styles through under every policy", () => {
    for (const policy of ["allow", "prompt", "block"] as const) {
      assert.deepEqual(gateRegionalBasemap(BLANK_BASEMAP, policy, DEFAULT_BASEMAP), {
        styleUrl: BLANK_BASEMAP,
      });
      const unknown = `${REGIONAL_BASEMAP_SENTINEL_PREFIX}retired`;
      assert.deepEqual(gateRegionalBasemap(unknown, policy, DEFAULT_BASEMAP), {
        styleUrl: unknown,
      });
    }
  });

  it("holds an untrusted regional basemap under prompt, but not a trusted one", () => {
    assert.deepEqual(gateRegionalBasemap(AMAP.styleUrl, "prompt", DEFAULT_BASEMAP), {
      styleUrl: DEFAULT_BASEMAP,
      held: "prompt",
    });
    assert.deepEqual(gateRegionalBasemap(AMAP.styleUrl, "prompt", DEFAULT_BASEMAP, true), {
      styleUrl: AMAP.styleUrl,
    });
  });

  it("always replaces a regional basemap under block, trusted or not", () => {
    for (const trusted of [false, true]) {
      assert.deepEqual(gateRegionalBasemap(AMAP.styleUrl, "block", DEFAULT_BASEMAP, trusted), {
        styleUrl: DEFAULT_BASEMAP,
        held: "blocked",
      });
    }
  });

  it("applies the basemap as is under allow", () => {
    assert.deepEqual(gateRegionalBasemap(AMAP.styleUrl, "allow", DEFAULT_BASEMAP), {
      styleUrl: AMAP.styleUrl,
    });
  });
});

describe("store regional-basemap gate", () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
    useAppStore.setState({ regionalBasemapAnswers: {} });
    useAppStore.getState().setRegionalBasemapPolicy("prompt");
  });
  afterEach(() => {
    useAppStore.getState().setRegionalBasemapPolicy("allow");
    useAppStore.getState().newProject();
  });

  it("defaults to allow, so library consumers see no change", () => {
    assert.equal(INITIAL_POLICY, "allow");
    useAppStore.getState().setRegionalBasemapPolicy("allow");
    useAppStore.getState().loadProject(projectWith(AMAP.styleUrl));
    assert.equal(useAppStore.getState().basemapStyleUrl, AMAP.styleUrl);
    assert.equal(useAppStore.getState().regionalBasemapHold, null);
  });

  it("opens an untrusted project on the default basemap and holds the regional one", () => {
    useAppStore.getState().loadProject(projectWith(AMAP.styleUrl), "/tmp/shared.geolibre");
    const state = useAppStore.getState();
    assert.equal(state.basemapStyleUrl, DEFAULT_BASEMAP);
    assert.deepEqual(state.regionalBasemapHold, {
      styleUrl: AMAP.styleUrl,
      reason: "prompt",
    });
    assert.equal(state.isDirty, false);
  });

  it("Load still applies the held basemap after a collaboration snapshot bumps the generation", () => {
    useAppStore.getState().loadProject(projectWith(AMAP.styleUrl));
    // useCollaboration bumps projectGeneration ~200 ms after an inbound snapshot,
    // with no new load: the pending prompt must still be answerable.
    useAppStore.setState((s) => ({ projectGeneration: s.projectGeneration + 1 }));
    useAppStore.getState().resolveRegionalBasemapHold(true);
    const state = useAppStore.getState();
    assert.equal(state.basemapStyleUrl, AMAP.styleUrl);
    assert.equal(state.regionalBasemapHold, null);
    assert.equal(state.regionalBasemapAnswers[AMAP.styleUrl], true);
  });

  it("Load applies the held basemap without dirtying the project or recording undo", () => {
    useAppStore.getState().loadProject(projectWith(TENCENT.styleUrl));
    useAppStore.getState().resolveRegionalBasemapHold(true);
    const state = useAppStore.getState();
    assert.equal(state.basemapStyleUrl, TENCENT.styleUrl);
    assert.equal(state.regionalBasemapHold, null);
    assert.equal(state.isDirty, false);
    assert.equal(useAppStore.temporal.getState().pastStates.length, 0);
  });

  it("Use default basemap keeps the fallback and clears the hold", () => {
    useAppStore.getState().loadProject(projectWith(AMAP.styleUrl));
    useAppStore.getState().resolveRegionalBasemapHold(false);
    const state = useAppStore.getState();
    assert.equal(state.basemapStyleUrl, DEFAULT_BASEMAP);
    assert.equal(state.regionalBasemapHold, null);
  });

  it("a project opened since clears the pending hold, so an old prompt has nothing to answer", () => {
    useAppStore.getState().loadProject(projectWith(AMAP.styleUrl));
    useAppStore.getState().loadProject(projectWith(DEFAULT_BASEMAP));
    assert.equal(useAppStore.getState().regionalBasemapHold, null);
    useAppStore.getState().resolveRegionalBasemapHold(true);
    assert.equal(useAppStore.getState().basemapStyleUrl, DEFAULT_BASEMAP);
    assert.equal(useAppStore.getState().regionalBasemapHold, null);
    assert.equal(useAppStore.getState().regionalBasemapAnswers[AMAP.styleUrl], undefined);
  });

  it("Load does not override a basemap the user picked while the prompt was open", () => {
    useAppStore.getState().loadProject(projectWith(AMAP.styleUrl));
    useAppStore.getState().setBasemapStyleUrl(BLANK_BASEMAP);
    useAppStore.getState().resolveRegionalBasemapHold(true);
    assert.equal(useAppStore.getState().basemapStyleUrl, BLANK_BASEMAP);
  });

  it("an explicit pick of the default basemap supersedes the prompt", () => {
    useAppStore.getState().loadProject(projectWith(AMAP.styleUrl));
    useAppStore.getState().setBasemapStyleUrl(DEFAULT_BASEMAP);
    assert.equal(useAppStore.getState().regionalBasemapHold, null);
    useAppStore.getState().resolveRegionalBasemapHold(true);
    assert.equal(useAppStore.getState().basemapStyleUrl, DEFAULT_BASEMAP);
  });

  it("an edit made while the prompt was open does not undo the accepted basemap", () => {
    useAppStore.getState().loadProject(projectWith(AMAP.styleUrl));
    useAppStore.getState().setBasemapOpacity(0.5);
    assert.equal(useAppStore.temporal.getState().pastStates.length, 1);
    useAppStore.getState().resolveRegionalBasemapHold(true);
    undo();
    const state = useAppStore.getState();
    assert.equal(state.basemapOpacity, 1);
    assert.equal(state.basemapStyleUrl, AMAP.styleUrl);
  });

  it("reuses the session's answer for the same basemap instead of asking again", () => {
    useAppStore.getState().loadProject(projectWith(AMAP.styleUrl));
    useAppStore.getState().resolveRegionalBasemapHold(true);
    useAppStore.getState().loadProject(projectWith(AMAP.styleUrl));
    assert.equal(useAppStore.getState().basemapStyleUrl, AMAP.styleUrl);
    assert.equal(useAppStore.getState().regionalBasemapHold, null);

    useAppStore.getState().loadProject(projectWith(TENCENT.styleUrl));
    assert.equal(useAppStore.getState().regionalBasemapHold?.styleUrl, TENCENT.styleUrl);
    useAppStore.getState().resolveRegionalBasemapHold(false);
    useAppStore.getState().loadProject(projectWith(TENCENT.styleUrl));
    assert.equal(useAppStore.getState().basemapStyleUrl, DEFAULT_BASEMAP);
    assert.equal(useAppStore.getState().regionalBasemapHold, null);
  });

  it("a dismissed prompt is not remembered, so the basemap asks again", () => {
    useAppStore.getState().loadProject(projectWith(AMAP.styleUrl));
    useAppStore.getState().resolveRegionalBasemapHold(false, { remember: false });
    assert.equal(useAppStore.getState().basemapStyleUrl, DEFAULT_BASEMAP);
    assert.equal(AMAP.styleUrl in useAppStore.getState().regionalBasemapAnswers, false);
    useAppStore.getState().loadProject(projectWith(AMAP.styleUrl));
    assert.equal(useAppStore.getState().regionalBasemapHold?.reason, "prompt");
  });

  it("picking a regional basemap after turning it down counts as Load", () => {
    useAppStore.getState().loadProject(projectWith(AMAP.styleUrl));
    useAppStore.getState().resolveRegionalBasemapHold(false);
    useAppStore.getState().setBasemapStyleUrl(AMAP.styleUrl);
    assert.equal(useAppStore.getState().regionalBasemapAnswers[AMAP.styleUrl], true);
    useAppStore.getState().loadProject(projectWith(AMAP.styleUrl));
    assert.equal(useAppStore.getState().basemapStyleUrl, AMAP.styleUrl);
    assert.equal(useAppStore.getState().regionalBasemapHold, null);
  });

  it("a trusted load (template, undo step, embed host) skips the prompt", () => {
    useAppStore.getState().loadProject(projectWith(AMAP.styleUrl), null, { trustBasemap: true });
    assert.equal(useAppStore.getState().basemapStyleUrl, AMAP.styleUrl);
    assert.equal(useAppStore.getState().regionalBasemapHold, null);
  });

  it("the user's own pick never prompts", () => {
    useAppStore.getState().setBasemapStyleUrl(AMAP.styleUrl);
    assert.equal(useAppStore.getState().basemapStyleUrl, AMAP.styleUrl);
    useAppStore.getState().newProject({ basemapStyleUrl: TENCENT.styleUrl });
    assert.equal(useAppStore.getState().basemapStyleUrl, TENCENT.styleUrl);
    assert.equal(useAppStore.getState().regionalBasemapHold, null);
  });

  it("a non-regional project opens untouched", () => {
    useAppStore.getState().loadProject(projectWith(BLANK_BASEMAP));
    assert.equal(useAppStore.getState().basemapStyleUrl, BLANK_BASEMAP);
    assert.equal(useAppStore.getState().regionalBasemapHold, null);
  });

  describe("when the deployment disables regional basemaps", () => {
    beforeEach(() => useAppStore.getState().setRegionalBasemapPolicy("block"));

    it("opens the project on the default basemap with a blocked notice", () => {
      useAppStore.getState().loadProject(projectWith(AMAP.styleUrl), null, { trustBasemap: true });
      const state = useAppStore.getState();
      assert.equal(state.basemapStyleUrl, DEFAULT_BASEMAP);
      assert.equal(state.regionalBasemapHold?.reason, "blocked");
      useAppStore.getState().resolveRegionalBasemapHold(true);
      assert.equal(useAppStore.getState().basemapStyleUrl, DEFAULT_BASEMAP);
    });

    it("refuses a regional basemap set directly or seeded into a new project", (t) => {
      t.mock.method(console, "warn", () => {});
      useAppStore.getState().setBasemapStyleUrl(AMAP.styleUrl);
      assert.equal(useAppStore.getState().basemapStyleUrl, DEFAULT_BASEMAP);
      useAppStore.getState().newProject({ basemapStyleUrl: TENCENT.styleUrl });
      assert.equal(useAppStore.getState().basemapStyleUrl, DEFAULT_BASEMAP);
    });

    it("switching to block drops a pending prompt", () => {
      useAppStore.getState().setRegionalBasemapPolicy("prompt");
      useAppStore.getState().loadProject(projectWith(AMAP.styleUrl));
      useAppStore.getState().setRegionalBasemapPolicy("block");
      assert.equal(useAppStore.getState().regionalBasemapHold, null);
    });

    it("switching to block takes down a regional basemap already on screen", () => {
      useAppStore.getState().setRegionalBasemapPolicy("prompt");
      useAppStore.getState().setBasemapStyleUrl(AMAP.styleUrl);
      useAppStore.getState().setRegionalBasemapPolicy("block");
      assert.equal(useAppStore.getState().basemapStyleUrl, DEFAULT_BASEMAP);
    });

    it("refuses a regional basemap through restoreEarthBasemap", (t) => {
      t.mock.method(console, "warn", () => {});
      useAppStore.getState().restoreEarthBasemap(TENCENT.styleUrl);
      assert.equal(useAppStore.getState().basemapStyleUrl, DEFAULT_BASEMAP);
    });

    it("undo cannot bring back a regional basemap recorded before the block", () => {
      useAppStore.getState().setRegionalBasemapPolicy("prompt");
      useAppStore.getState().setBasemapStyleUrl(AMAP.styleUrl);
      // Start the history here so the only undo step restores AMAP rather than
      // whatever a coalesced burst recorded before it.
      clearHistory();
      useAppStore.getState().setBasemapStyleUrl(BLANK_BASEMAP);
      const temporal = useAppStore.temporal.getState();
      assert.equal(temporal.pastStates.at(-1)?.basemapStyleUrl, AMAP.styleUrl);
      useAppStore.getState().setRegionalBasemapPolicy("block");
      undo();
      assert.equal(useAppStore.getState().basemapStyleUrl, DEFAULT_BASEMAP);
      // The correction is not an edit: redo still returns to the later step.
      assert.equal(useAppStore.temporal.getState().pastStates.length, 0);
      redo();
      assert.equal(useAppStore.getState().basemapStyleUrl, BLANK_BASEMAP);
    });
  });
});

describe("regional-basemap deployment switch", () => {
  afterEach(() => setDeploymentPolicy(null));

  it("reads the VITE_* switch from the deployment env, then the build env", () => {
    for (const value of ["1", "true", " TRUE "]) {
      assert.equal(regionalBasemapsDisabled({ [DISABLE_REGIONAL_BASEMAPS_ENV]: value }, {}), true);
    }
    for (const value of ["0", "false", " FALSE ", "", "  "]) {
      assert.equal(regionalBasemapsDisabled({ [DISABLE_REGIONAL_BASEMAPS_ENV]: value }, {}), false);
    }
  });

  it("fails closed with a warning on an unrecognised value", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    for (const value of ["yes", "on", "2"]) {
      assert.equal(regionalBasemapsDisabled({ [DISABLE_REGIONAL_BASEMAPS_ENV]: value }, {}), true);
    }
    assert.equal(warn.mock.callCount(), 3);
  });

  it("prefers the deployment env over the build env", () => {
    assert.equal(regionalBasemapsDisabled({}, { [DISABLE_REGIONAL_BASEMAPS_ENV]: "1" }), true);
    // A deployment "0" beats a build-time "1".
    assert.equal(
      regionalBasemapsDisabled(
        { [DISABLE_REGIONAL_BASEMAPS_ENV]: "0" },
        { [DISABLE_REGIONAL_BASEMAPS_ENV]: "1" },
      ),
      false,
    );
    assert.equal(regionalBasemapsDisabled({}, {}), false);
  });

  it("maps basemaps.regional onto the env overlay", () => {
    assert.equal(
      policyEnvOverlay({ version: 1, basemaps: { regional: false } })[
        DISABLE_REGIONAL_BASEMAPS_ENV
      ],
      "1",
    );
    assert.equal(
      policyEnvOverlay({ version: 1, basemaps: { regional: true } })[DISABLE_REGIONAL_BASEMAPS_ENV],
      "0",
    );
    assert.equal(
      DISABLE_REGIONAL_BASEMAPS_ENV in policyEnvOverlay({ version: 1, basemaps: {} }),
      false,
    );
  });

  it("a policy with regional: false resolves to block, otherwise prompt", () => {
    setDeploymentPolicy({ version: 1, basemaps: { regional: false } });
    assert.equal(resolveRegionalBasemapPolicy(), "block");
    setDeploymentPolicy({ version: 1, basemaps: { regional: true } });
    assert.equal(resolveRegionalBasemapPolicy(), "prompt");
    setDeploymentPolicy(null);
    assert.equal(resolveRegionalBasemapPolicy(), "prompt");
  });
});
