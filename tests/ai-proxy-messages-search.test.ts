import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMessagesSearchRequest,
  parseMessagesSearchResponse,
  searchResultLimit,
} from "../workers/ai-proxy/src/index";

describe("AI proxy messages search request", () => {
  it("turns a news lookback into an explicit recency instruction", () => {
    const request = buildMessagesSearchRequest(
      { topic: "news", days: 30, max_results: 8 },
      "Colorado wildfire impacts",
    );
    const messages = request.messages as { role: string; content: string }[];
    assert.match(messages[0].content, /within the last 30 days/);
    assert.match(request.system as string, /at most 8 results/);
    assert.equal(request.model, "gpt-5.6-luna");
  });

  it("clamps max_results into the documented range", () => {
    assert.match(
      buildMessagesSearchRequest({ max_results: 99 }, "q").system as string,
      /at most 20 results/,
    );
    assert.match(
      buildMessagesSearchRequest({ max_results: 0 }, "q").system as string,
      /at most 1 results/,
    );
  });

  it("ignores a lookback for retrospective general searches", () => {
    const request = buildMessagesSearchRequest({ topic: "general", days: 30 }, "Valencia flood");
    const messages = request.messages as { role: string; content: string }[];
    assert.doesNotMatch(messages[0].content, /last 30 days/);
  });

  it("honours an operator model override", () => {
    assert.equal(buildMessagesSearchRequest({}, "q", "claude-opus-5").model, "claude-opus-5");
  });

  it("always requests the server-side web_search tool", () => {
    const tools = buildMessagesSearchRequest({}, "q").tools as { type: string }[];
    assert.equal(tools[0].type, "web_search_20250305");
  });

  it("shares one clamped limit between the prompt and the response cap", () => {
    assert.equal(searchResultLimit({}), 6);
    assert.equal(searchResultLimit({ max_results: 8 }), 8);
    assert.equal(searchResultLimit({ max_results: 99 }), 20);
    assert.equal(searchResultLimit({ max_results: 0 }), 1);
    assert.equal(searchResultLimit({ max_results: Number.NaN }), 6);
  });
});

describe("AI proxy messages search response", () => {
  const searchBlock = {
    type: "web_search_tool_result",
    content: [
      {
        type: "web_search_result",
        title: "Hit A",
        url: "https://a.example/x",
        page_age: "2024-11-02",
      },
      { type: "web_search_result", title: "Hit B", url: "https://b.example/y", page_age: "None" },
    ],
  };

  it("maps model JSON onto the Tavily envelope", () => {
    const parsed = parseMessagesSearchResponse({
      content: [
        searchBlock,
        {
          type: "text",
          text: JSON.stringify({
            answer: "At least 200 died.",
            results: [
              { title: "Hit A", url: "https://a.example/x", content: "…at least 200 deaths…" },
            ],
          }),
        },
      ],
    });
    assert.equal(parsed.answer, "At least 200 died.");
    assert.deepEqual(parsed.results, [
      {
        title: "Hit A",
        url: "https://a.example/x",
        content: "…at least 200 deaths…",
        published_date: "2024-11-02",
      },
    ]);
  });

  it("tolerates a fenced JSON reply", () => {
    const parsed = parseMessagesSearchResponse({
      content: [
        searchBlock,
        {
          type: "text",
          text: '```json\n{"answer":"ok","results":[{"url":"https://b.example/y","content":"c"}]}\n```',
        },
      ],
    });
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.results[0].title, "Hit B", "falls back to the search hit's title");
  });

  it("drops the page_age sentinel rather than emitting it as a date", () => {
    const parsed = parseMessagesSearchResponse({
      content: [
        searchBlock,
        { type: "text", text: '{"results":[{"url":"https://b.example/y","content":"c"}]}' },
      ],
    });
    assert.equal("published_date" in parsed.results[0], false);
  });

  it("falls back to raw search hits when the model returns prose", () => {
    const parsed = parseMessagesSearchResponse({
      content: [searchBlock, { type: "text", text: "I could not format that." }],
    });
    assert.deepEqual(
      parsed.results.map((r) => r.url),
      ["https://a.example/x", "https://b.example/y"],
    );
    assert.equal(parsed.answer, "I could not format that.");
  });

  it("drops a claimed entry that carries no url", () => {
    const parsed = parseMessagesSearchResponse({
      content: [
        searchBlock,
        { type: "text", text: '{"results":[{"title":"No url","content":"c"}]}' },
      ],
    });
    assert.deepEqual(
      parsed.results.map((r) => r.url),
      ["https://a.example/x", "https://b.example/y"],
    );
  });

  it("drops a url the search never returned, so an invented link cannot be cited", () => {
    const parsed = parseMessagesSearchResponse({
      content: [
        searchBlock,
        {
          type: "text",
          text: JSON.stringify({
            answer: "a",
            results: [
              {
                url: "https://invented.example/fabricated",
                title: "Looks real",
                content: "200 deaths",
              },
              { url: "https://a.example/x", title: "Hit A", content: "real" },
            ],
          }),
        },
      ],
    });
    assert.deepEqual(
      parsed.results.map((r) => r.url),
      ["https://a.example/x"],
    );
  });

  it("keeps the model's own citations when the backend surfaced no hits", () => {
    // cli-proxy-api in front of a non-Anthropic model runs the search but
    // returns the tool-result block empty, so there is nothing to ground
    // against; dropping every citation would leave an answer with no sources.
    const parsed = parseMessagesSearchResponse({
      content: [
        { type: "web_search_tool_result", content: [] },
        {
          type: "text",
          text: JSON.stringify({
            answer: "Six died in Indiana.",
            results: [
              { title: "Indiana floods", url: "https://news.example/indiana", content: "six dead" },
            ],
          }),
        },
      ],
    });
    assert.equal(parsed.answer, "Six died in Indiana.");
    assert.deepEqual(parsed.results, [
      { title: "Indiana floods", url: "https://news.example/indiana", content: "six dead" },
    ]);
    // The URLs went out unverified, so the route can log that it happened.
    assert.equal(parsed.grounded, false);
  });

  it("still refuses an invented url once the backend has surfaced any hit", () => {
    const parsed = parseMessagesSearchResponse({
      content: [
        searchBlock,
        {
          type: "text",
          text: JSON.stringify({
            results: [{ url: "https://invented.example/z", title: "Looks real", content: "c" }],
          }),
        },
      ],
    });
    assert.deepEqual(
      parsed.results.map((r) => r.url),
      ["https://a.example/x", "https://b.example/y"],
    );
    assert.equal(parsed.grounded, true);
  });

  it("falls back to the search hits when every claimed url was invented", () => {
    const parsed = parseMessagesSearchResponse({
      content: [
        searchBlock,
        { type: "text", text: '{"results":[{"url":"https://invented.example/z","content":"c"}]}' },
      ],
    });
    assert.deepEqual(
      parsed.results.map((r) => r.url),
      ["https://a.example/x", "https://b.example/y"],
    );
  });

  it("drops a claimed entry whose snippet is blank, since it grounds nothing", () => {
    const parsed = parseMessagesSearchResponse({
      content: [
        searchBlock,
        {
          type: "text",
          text: JSON.stringify({
            results: [
              { url: "https://a.example/x", title: "Hit A", content: "   " },
              { url: "https://b.example/y", title: "Hit B", content: "real extract" },
            ],
          }),
        },
      ],
    });
    assert.deepEqual(
      parsed.results.map((r) => r.url),
      ["https://b.example/y"],
    );
  });

  it("falls back to the search hits when every claimed snippet is blank", () => {
    const parsed = parseMessagesSearchResponse({
      content: [
        searchBlock,
        { type: "text", text: '{"results":[{"url":"https://a.example/x","content":""}]}' },
      ],
    });
    assert.deepEqual(
      parsed.results.map((r) => r.url),
      ["https://a.example/x", "https://b.example/y"],
    );
  });

  it("caps claimed results at the requested limit", () => {
    const parsed = parseMessagesSearchResponse(
      {
        content: [
          searchBlock,
          {
            type: "text",
            text: JSON.stringify({
              results: [
                { url: "https://a.example/x", content: "one" },
                { url: "https://b.example/y", content: "two" },
              ],
            }),
          },
        ],
      },
      1,
    );
    assert.deepEqual(
      parsed.results.map((r) => r.url),
      ["https://a.example/x"],
    );
  });

  it("caps the fallback hits at the requested limit too", () => {
    const parsed = parseMessagesSearchResponse(
      { content: [searchBlock, { type: "text", text: "prose, not json" }] },
      1,
    );
    assert.equal(parsed.results.length, 1);
  });

  it("returns an empty envelope for a response with no content", () => {
    assert.deepEqual(parseMessagesSearchResponse({}), {
      results: [],
      answer: undefined,
      grounded: false,
    });
  });
});
