/**
 * Builds the prompts the SQL Workspace hands to the AI assistant: "Fix" for a
 * query that failed, "Explain" for the query in the editor.
 *
 * Pure, so the wording rules can be tested without a panel. The sentences
 * themselves come from the message catalog (the user reads the prompt in the
 * composer before sending it, and a translated instruction gets a reply in the
 * user's language), so this module only arranges them around the SQL and the
 * engine's error.
 */

/** The SQL Workspace's engines. */
export type SqlPromptEngine = "duckdb" | "postgis" | "sedona";

/**
 * Longest query quoted in a prompt. Far above anything typed by hand; it only
 * bites on a pasted statement carrying a large inline geometry or VALUES list,
 * where the tail adds provider cost and no information.
 */
export const MAX_PROMPT_SQL_CHARS = 12_000;

/** Longest engine error quoted in a prompt. */
export const MAX_PROMPT_ERROR_CHARS = 4_000;

/** The catalog strings a prompt is assembled from, already translated. */
export interface SqlPromptText {
  /** The opening request, e.g. "This DuckDB query failed…". */
  instruction: string;
  /**
   * A line saying the query does not run on DuckDB, for the engines the
   * assistant's own SQL tool cannot run. Omitted for DuckDB.
   */
  engineNote?: string;
  /** Heading above the quoted query, e.g. "Query:". */
  queryLabel: string;
  /** Heading above the quoted error, e.g. "Error:". Only "Fix" uses it. */
  errorLabel: string;
  /** Marker appended to a quoted block that was cut short. */
  truncated: string;
}

/**
 * The product name of a SQL Workspace engine, as the engine picker shows it.
 * These are proper nouns, so they are not translated.
 *
 * @param engine The engine id.
 * @returns The display name.
 */
export function sqlEngineName(engine: SqlPromptEngine): string {
  if (engine === "postgis") return "PostGIS";
  if (engine === "sedona") return "Apache Sedona";
  return "DuckDB";
}

/**
 * Whether the assistant's own SQL tool can run a query written for an engine.
 * That tool is DuckDB, so a PostGIS or Sedona query needs the note telling the
 * assistant to keep the dialect rather than "fix" it into DuckDB syntax.
 *
 * @param engine The engine id.
 * @returns True for DuckDB.
 */
export function assistantRunsEngine(engine: SqlPromptEngine): boolean {
  return engine === "duckdb";
}

function clip(value: string, limit: number, marker: string): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trimEnd()}\n${marker}`;
}

/**
 * Wrap text in a Markdown code fence that the text itself cannot close: one
 * backtick longer than the longest run inside it, and never fewer than three.
 */
function fence(content: string, language = ""): string {
  const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(Math.max(3, longestRun + 1));
  return `${ticks}${language}\n${content}\n${ticks}`;
}

function opening(text: SqlPromptText): string {
  return text.engineNote ? `${text.instruction} ${text.engineNote}` : text.instruction;
}

/**
 * The prompt asking the assistant to correct a failed query.
 *
 * @param input.sql The statement that was run.
 * @param input.error The error shown in the workspace for it.
 * @param text The translated catalog strings.
 * @returns The prompt, or null when there is no query to fix.
 */
export function buildSqlFixPrompt(
  input: { sql: string; error: string },
  text: SqlPromptText,
): string | null {
  const sql = input.sql.trim();
  if (!sql) return null;
  const error = input.error.trim();
  const parts = [
    opening(text),
    `${text.queryLabel}\n${fence(clip(sql, MAX_PROMPT_SQL_CHARS, text.truncated), "sql")}`,
  ];
  if (error) {
    parts.push(`${text.errorLabel}\n${fence(clip(error, MAX_PROMPT_ERROR_CHARS, text.truncated))}`);
  }
  return parts.join("\n\n");
}

/**
 * The prompt asking the assistant what a query does.
 *
 * @param input.sql The statement in the editor.
 * @param text The translated catalog strings.
 * @returns The prompt, or null when the editor is empty.
 */
export function buildSqlExplainPrompt(input: { sql: string }, text: SqlPromptText): string | null {
  const sql = input.sql.trim();
  if (!sql) return null;
  return [
    opening(text),
    `${text.queryLabel}\n${fence(clip(sql, MAX_PROMPT_SQL_CHARS, text.truncated), "sql")}`,
  ].join("\n\n");
}
