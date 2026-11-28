import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assistantRunsEngine,
  buildSqlExplainPrompt,
  buildSqlFixPrompt,
  MAX_PROMPT_ERROR_CHARS,
  MAX_PROMPT_SQL_CHARS,
  sqlEngineName,
  type SqlPromptText,
} from "../apps/geolibre-desktop/src/lib/sql-assistant-prompts";

const TEXT: SqlPromptText = {
  instruction: "This DuckDB query failed.",
  queryLabel: "Query:",
  errorLabel: "Error:",
  truncated: "(cut short here)",
};

describe("sqlEngineName", () => {
  it("names each engine the way the engine picker does", () => {
    assert.equal(sqlEngineName("duckdb"), "DuckDB");
    assert.equal(sqlEngineName("postgis"), "PostGIS");
    assert.equal(sqlEngineName("sedona"), "Apache Sedona");
  });
});

describe("assistantRunsEngine", () => {
  it("is true only for DuckDB, the engine behind the assistant's SQL tool", () => {
    assert.equal(assistantRunsEngine("duckdb"), true);
    assert.equal(assistantRunsEngine("postgis"), false);
    assert.equal(assistantRunsEngine("sedona"), false);
  });
});

describe("buildSqlFixPrompt", () => {
  it("opens with the instruction, then quotes the query and the error", () => {
    const prompt = buildSqlFixPrompt(
      {
        sql: "  SELECT * FROM citys  ",
        error: 'Catalog Error: Table with name "citys" does not exist!\n',
      },
      TEXT,
    );
    assert.equal(
      prompt,
      [
        "This DuckDB query failed.",
        "",
        "Query:",
        "```sql",
        "SELECT * FROM citys",
        "```",
        "",
        "Error:",
        "```",
        'Catalog Error: Table with name "citys" does not exist!',
        "```",
      ].join("\n"),
    );
  });

  it("puts the engine note on the opening line when there is one", () => {
    const prompt = buildSqlFixPrompt(
      { sql: "SELECT 1", error: "boom" },
      { ...TEXT, engineNote: "It runs on PostGIS, not DuckDB." },
    );
    assert.equal(
      prompt?.split("\n")[0],
      "This DuckDB query failed. It runs on PostGIS, not DuckDB.",
    );
  });

  it("leaves the error section out when the engine gave no message", () => {
    const prompt = buildSqlFixPrompt({ sql: "SELECT 1", error: "  " }, TEXT);
    assert.ok(prompt);
    assert.ok(!prompt.includes("Error:"));
    assert.ok(prompt.endsWith("```sql\nSELECT 1\n```"));
  });

  it("returns null when there is no query", () => {
    assert.equal(buildSqlFixPrompt({ sql: " \n ", error: "boom" }, TEXT), null);
  });

  it("uses a fence the quoted text cannot close", () => {
    const prompt = buildSqlFixPrompt(
      { sql: "SELECT '```' AS fence", error: "near ````: syntax error" },
      TEXT,
    );
    assert.ok(prompt);
    assert.ok(prompt.includes("````sql\nSELECT '```' AS fence\n````"));
    assert.ok(prompt.includes("`````\nnear ````: syntax error\n`````"));
  });

  it("cuts an oversized query and error short and says so", () => {
    const prompt = buildSqlFixPrompt(
      {
        sql: `SELECT '${"x".repeat(MAX_PROMPT_SQL_CHARS)}'`,
        error: "e".repeat(MAX_PROMPT_ERROR_CHARS + 1),
      },
      TEXT,
    );
    assert.ok(prompt);
    assert.equal(prompt.split("(cut short here)").length - 1, 2);
    assert.ok(prompt.length < MAX_PROMPT_SQL_CHARS + MAX_PROMPT_ERROR_CHARS + 200);
    // The marker sits inside the fence, on its own line.
    assert.ok(prompt.includes("x\n(cut short here)\n```"));
    assert.ok(prompt.endsWith("e\n(cut short here)\n```"));
  });

  it("does not split a surrogate pair at the cut", () => {
    // "SELECT '" is 8 units, so the limit lands between the halves of an emoji.
    const sql = `SELECT '${"x".repeat(MAX_PROMPT_SQL_CHARS - 9)}\u{1F30D}'`;
    const prompt = buildSqlExplainPrompt({ sql }, TEXT);
    assert.ok(prompt);
    assert.ok(prompt.includes("x\n(cut short here)"));
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(prompt));
  });

  it("does not mark text that fits exactly", () => {
    const sql = "x".repeat(MAX_PROMPT_SQL_CHARS);
    const prompt = buildSqlFixPrompt({ sql, error: "boom" }, TEXT);
    assert.ok(prompt?.includes(sql));
    assert.ok(!prompt?.includes("(cut short here)"));
  });
});

describe("buildSqlExplainPrompt", () => {
  const text = { ...TEXT, instruction: "Explain what this DuckDB query does." };

  it("opens with the instruction and quotes the query, with no error section", () => {
    assert.equal(
      buildSqlExplainPrompt({ sql: "SELECT name\nFROM cities\n" }, text),
      [
        "Explain what this DuckDB query does.",
        "",
        "Query:",
        "```sql",
        "SELECT name\nFROM cities",
        "```",
      ].join("\n"),
    );
  });

  it("returns null for an empty editor", () => {
    assert.equal(buildSqlExplainPrompt({ sql: "" }, text), null);
  });

  it("carries the engine note", () => {
    const prompt = buildSqlExplainPrompt(
      { sql: "SELECT 1" },
      { ...text, engineNote: "It runs on Apache Sedona, not DuckDB." },
    );
    assert.ok(prompt?.startsWith("Explain what this DuckDB query does. It runs on Apache Sedona"));
  });
});
