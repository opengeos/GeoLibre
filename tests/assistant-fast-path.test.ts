import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFastPathQuestions,
  fastPathFitsProject,
  interpretFastPathAnswers,
  resolveFastPathAction,
  resolveFastPathEndpoint,
  FAST_PATH_MAX_CHOICES,
  TYPESAFE_ENDPOINT,
  type FastPathAnswers,
  type FastPathFetch,
  type FastPathState,
} from "../apps/geolibre-desktop/src/lib/assistant/fast-path";

const STATE: FastPathState = {
  layers: [
    { id: "lyr_rivers", name: "Major Rivers", type: "vector" },
    { id: "lyr_dem", name: "SRTM Elevation", type: "raster" },
  ],
  styleBasemaps: [
    { id: "dark", name: "Dark" },
    { id: "positron", name: "Positron" },
  ],
  tileBasemaps: [{ id: "opentopomap", name: "OpenTopoMap" }],
};

/** A confident answer set, overridable per case. */
function answers(overrides: FastPathAnswers = {}): FastPathAnswers {
  return {
    intent: { choice: "complex", confidence: 1 },
    layer: { choice: "none", confidence: 1 },
    styleBasemap: { choice: "none", confidence: 1 },
    tileBasemap: { choice: "none", confidence: 1 },
    visible: { noul: 0.5 },
    opacity: { score: 2, confidence: 1 },
    ...overrides,
  };
}

describe("fast-path routing", () => {
  it("falls through for anything that is not one of the simple commands", () => {
    assert.equal(interpretFastPathAnswers(answers(), STATE), null);
  });

  it("routes a visibility request to the layer it names", () => {
    const action = interpretFastPathAnswers(
      answers({
        intent: { choice: "set_layer_visibility", confidence: 0.99 },
        layer: { choice: "lyr_rivers", confidence: 0.99 },
        visible: { noul: 0.02 },
      }),
      STATE,
    );
    assert.deepEqual(action, {
      tool: "set_layer_visibility",
      input: { layer: "lyr_rivers", visible: false },
    });
  });

  it("treats a Noul near 0.5 as ambiguity rather than a half-measure", () => {
    // Show and hide are opposites; a coin flip between them is not an answer.
    const action = interpretFastPathAnswers(
      answers({
        intent: { choice: "set_layer_visibility", confidence: 0.99 },
        layer: { choice: "lyr_rivers", confidence: 0.99 },
        visible: { noul: 0.5 },
      }),
      STATE,
    );
    assert.equal(action, null);
  });

  it("maps the opacity Score across the full 0-1 range", () => {
    const opacityFor = (score: number) =>
      interpretFastPathAnswers(
        answers({
          intent: { choice: "set_layer_opacity", confidence: 0.99 },
          layer: { choice: "lyr_dem", confidence: 0.99 },
          opacity: { score },
        }),
        STATE,
      )?.input.opacity;

    assert.equal(opacityFor(0), 0);
    assert.equal(opacityFor(2), 0.5);
    assert.equal(opacityFor(4), 1);
    // The Score is continuous, so a value between levels must not snap.
    assert.equal(opacityFor(1), 0.25);
  });

  it("holds a destructive intent to a higher bar than a reversible one", () => {
    const withConfidence = (intent: string, confidence: number) =>
      interpretFastPathAnswers(
        answers({
          intent: { choice: intent, confidence: 0.99 },
          layer: { choice: "lyr_dem", confidence },
        }),
        STATE,
      );

    // The same layer confidence that is good enough to zoom is not good enough
    // to delete: a wrong zoom is visible and cheap, a wrong delete is not.
    assert.ok(withConfidence("zoom_to", 0.9));
    assert.equal(withConfidence("remove_layer", 0.9), null);
    assert.ok(withConfidence("remove_layer", 0.97));
  });

  it("refuses a layer that is not on the map", () => {
    const action = interpretFastPathAnswers(
      answers({
        intent: { choice: "zoom_to", confidence: 0.99 },
        layer: { choice: "lyr_ghost", confidence: 1 },
      }),
      STATE,
    );
    assert.equal(action, null);
  });

  it("falls through when the intent itself is not confident", () => {
    const action = interpretFastPathAnswers(
      answers({
        intent: { choice: "remove_layer", confidence: 0.6 },
        layer: { choice: "lyr_dem", confidence: 1 },
      }),
      STATE,
    );
    assert.equal(action, null);
  });

  it("separates a basemap style switch from adding a tile layer", () => {
    assert.deepEqual(
      interpretFastPathAnswers(
        answers({
          intent: { choice: "set_basemap", confidence: 0.99 },
          styleBasemap: { choice: "dark", confidence: 0.99 },
        }),
        STATE,
      ),
      { tool: "set_basemap", input: { basemap: "dark" } },
    );
    assert.deepEqual(
      interpretFastPathAnswers(
        answers({
          intent: { choice: "add_tile_layer", confidence: 0.99 },
          tileBasemap: { choice: "opentopomap", confidence: 0.99 },
        }),
        STATE,
      ),
      { tool: "add_tile_layer", input: { basemap: "opentopomap" } },
    );
  });

  it("will not zoom without a layer, because a bbox is not a judgment", () => {
    const action = interpretFastPathAnswers(
      answers({ intent: { choice: "zoom_to", confidence: 1 } }),
      STATE,
    );
    assert.equal(action, null);
  });
});

describe("fast-path questions", () => {
  it("offers every layer plus an explicit no-match option", () => {
    const questions = buildFastPathQuestions(STATE) as Record<
      string,
      { criteria: Record<string, string> }
    >;
    const layerOptions = Object.keys(questions.layer.criteria);
    assert.deepEqual(layerOptions, ["lyr_rivers", "lyr_dem", "none"]);
    assert.ok("complex" in questions.intent.criteria);
  });

  it("stands down rather than truncate a project past the choice cap", () => {
    const many = (count: number): FastPathState => ({
      ...STATE,
      layers: Array.from({ length: count }, (_, index) => ({
        id: `lyr_${index}`,
        name: `Layer ${index}`,
        type: "vector",
      })),
    });
    // One slot is reserved for `none`, so the cap is hit one layer early.
    assert.equal(fastPathFitsProject(many(FAST_PATH_MAX_CHOICES - 1)), true);
    assert.equal(fastPathFitsProject(many(FAST_PATH_MAX_CHOICES)), false);
  });
});

describe("fast-path endpoint", () => {
  it("prefers a managed proxy and sends no credential to it", () => {
    assert.deepEqual(
      resolveFastPathEndpoint({
        GEOLIBRE_AI_PROXY_BASE_URL: "https://ai.geolibre.app/",
        JEV_API_KEY: "personal-key",
      }),
      { url: "https://ai.geolibre.app/systemone", apiKey: null },
    );
  });

  it("falls back to calling TypeSafe with the user's own key", () => {
    assert.deepEqual(resolveFastPathEndpoint({ JEV_API_KEY: "  abc  " }), {
      url: TYPESAFE_ENDPOINT,
      apiKey: "abc",
    });
  });

  it("is off when nothing is configured", () => {
    assert.equal(resolveFastPathEndpoint({}), null);
    assert.equal(resolveFastPathEndpoint({ JEV_API_KEY: "   " }), null);
  });
});

describe("fast-path request", () => {
  const endpoint = { url: "https://example.test/systemone", apiKey: "k" };

  /** A transport returning one canned System One response. */
  const respondWith =
    (body: unknown, ok = true): FastPathFetch =>
    async () => ({ ok, status: ok ? 200 : 500, json: async () => body });

  it("returns the routed action on a confident answer", async () => {
    const action = await resolveFastPathAction({
      prompt: "hide the rivers",
      state: STATE,
      endpoint,
      fetchImpl: respondWith({
        answers: answers({
          intent: { choice: "set_layer_visibility", confidence: 1 },
          layer: { choice: "lyr_rivers", confidence: 1 },
          visible: { noul: 0.01 },
        }),
      }),
    });
    assert.deepEqual(action, {
      tool: "set_layer_visibility",
      input: { layer: "lyr_rivers", visible: false },
    });
  });

  it("omits Authorization when the endpoint carries its own credential", async () => {
    let sent: Record<string, string> | undefined;
    const capture: FastPathFetch = async (_url, init) => {
      sent = init.headers;
      return { ok: true, status: 200, json: async () => ({ answers: answers() }) };
    };

    await resolveFastPathAction({
      prompt: "hide the rivers",
      state: STATE,
      endpoint: { url: "https://ai.geolibre.app/systemone", apiKey: null },
      fetchImpl: capture,
    });
    assert.equal(sent?.Authorization, undefined);

    await resolveFastPathAction({
      prompt: "hide the rivers",
      state: STATE,
      endpoint,
      fetchImpl: capture,
    });
    assert.equal(sent?.Authorization, "Bearer k");
  });

  it("falls through instead of throwing on every transport failure", async () => {
    const cases: FastPathFetch[] = [
      respondWith({}, false), // HTTP error (e.g. a refused origin)
      respondWith({ nonsense: true }), // no answers
      async () => {
        throw new Error("network down");
      },
      async () => ({ ok: true, status: 200, json: async () => JSON.parse("{") }),
    ];
    for (const fetchImpl of cases) {
      const action = await resolveFastPathAction({
        prompt: "hide the rivers",
        state: STATE,
        endpoint,
        fetchImpl,
      });
      assert.equal(action, null);
    }
  });

  it("gives up once it stops being fast", async () => {
    const slow: FastPathFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const started = Date.now();
    const action = await resolveFastPathAction({
      prompt: "hide the rivers",
      state: STATE,
      endpoint,
      fetchImpl: slow,
      timeoutMs: 30,
    });
    assert.equal(action, null);
    assert.ok(Date.now() - started < 1_000, "abandoned the request rather than waiting");
  });

  it("does not call out at all for a project past the choice cap", async () => {
    let called = false;
    const action = await resolveFastPathAction({
      prompt: "hide the rivers",
      state: {
        ...STATE,
        layers: Array.from({ length: FAST_PATH_MAX_CHOICES + 1 }, (_, index) => ({
          id: `lyr_${index}`,
          name: `Layer ${index}`,
          type: "vector",
        })),
      },
      endpoint,
      fetchImpl: async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({ answers: answers() }) };
      },
    });
    assert.equal(action, null);
    assert.equal(called, false);
  });
});
