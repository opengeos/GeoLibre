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
});
