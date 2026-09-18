import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTavilySearchRequest } from "../workers/ai-proxy/src/index";

describe("AI proxy Tavily request", () => {
  it("converts an explicit news lookback to a supported start_date", () => {
    const request = buildTavilySearchRequest(
      { topic: "news", days: 30, max_results: 8 },
      "Colorado wildfire impacts",
      new Date("2026-08-10T12:00:00Z"),
    );

    assert.deepEqual(request, {
      query: "Colorado wildfire impacts",
      max_results: 8,
      topic: "news",
      search_depth: "advanced",
      include_answer: true,
      start_date: "2026-07-11",
    });
    assert.equal("days" in request, false);
  });

  it("lets Tavily apply its default news window when days is omitted", () => {
    const request = buildTavilySearchRequest({ topic: "news" }, "Colorado wildfire updates");

    assert.equal("start_date" in request, false);
    assert.equal("days" in request, false);
  });

  it("ignores a news lookback for general retrospective searches", () => {
    const request = buildTavilySearchRequest(
      { topic: "general", days: 3650 },
      "Colorado wildfire official assessment",
    );

    assert.equal(request.topic, "general");
    assert.equal("start_date" in request, false);
  });

  it("clamps max_results to the documented bounds", () => {
    const query = "Colorado wildfire impacts";
    const resultsFor = (max_results: unknown) =>
      buildTavilySearchRequest({ max_results }, query).max_results;

    assert.equal(resultsFor(20), 20);
    assert.equal(resultsFor(21), 20);
    assert.equal(resultsFor(1), 1);
    assert.equal(resultsFor(0), 1);
    assert.equal(resultsFor(-5), 1);
    // Fractions floor rather than reaching Tavily as a non-integer count.
    assert.equal(resultsFor(7.9), 7);
  });

  it("defaults max_results whenever the client sends something unusable", () => {
    const query = "Colorado wildfire impacts";
    // A numeric string is the likely mistake, and Number.isFinite rejects it, so
    // it must not fall through to an uncapped or NaN count.
    for (const unusable of [undefined, null, "8", Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(buildTavilySearchRequest({ max_results: unusable }, query).max_results, 6);
    }
  });

  it("treats any topic other than news as general", () => {
    const query = "Colorado wildfire impacts";
    for (const topic of [undefined, "finance", "News", 7]) {
      assert.equal(buildTavilySearchRequest({ topic }, query).topic, "general");
    }
    assert.equal(buildTavilySearchRequest({ topic: "news" }, query).topic, "news");
  });
});
