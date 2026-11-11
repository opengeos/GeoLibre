/**
 * A small, safe interpreter for the subset of the QGIS expression language
 * that attribute-form setups actually use (issue #3398): default values such
 * as `now()`, `uuid()`, `"site" || '_' || format_date(now(), 'yyyyMMdd')` or
 * `coalesce(@position_horizontal_accuracy, @gnss_horizontal_accuracy)`, and
 * simple constraints such as `length(beekeeper) > 1`.
 *
 * Expressions are tokenized and parsed into an AST, then walked: nothing is
 * ever handed to `eval`/`Function`, so an expression that arrives inside an
 * imported QGIS project (untrusted input) can only call the functions listed
 * in {@link FUNCTIONS}. Anything outside the subset (aggregates, layer
 * lookups such as `get_feature`, geometry processing) fails with an error
 * the caller can surface instead of producing a wrong value.
 *
 * Values follow QGIS semantics where it matters for forms: an unknown
 * `@variable` is NULL rather than an error (so `coalesce(@a, @b)` works when
 * neither is set), NULL propagates through arithmetic, comparison and `||`,
 * and `AND`/`OR` use three-valued logic.
 */
import type { Geometry } from "geojson";

/** Parsed QGIS expression. */
export type QgisExpressionNode =
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "field"; name: string }
  | { type: "variable"; name: string }
  | { type: "special"; name: string }
  | { type: "call"; name: string; args: QgisExpressionNode[] }
  | { type: "unary"; op: "-" | "not"; arg: QgisExpressionNode }
  | { type: "binary"; op: QgisBinaryOperator; left: QgisExpressionNode; right: QgisExpressionNode }
  | { type: "isNull"; arg: QgisExpressionNode; negated: boolean }
  | { type: "in"; arg: QgisExpressionNode; list: QgisExpressionNode[]; negated: boolean }
  | {
      type: "case";
      branches: { when: QgisExpressionNode; then: QgisExpressionNode }[];
      otherwise: QgisExpressionNode | null;
    };

export type QgisBinaryOperator =
  | "or"
  | "and"
  | "="
  | "<>"
  | "<"
  | "<="
  | ">"
  | ">="
  | "like"
  | "ilike"
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "^"
  | "||";

/** What an expression is evaluated against. */
export interface QgisExpressionContext {
  /** Attribute values of the feature being edited (`"field"` references). */
  properties?: Record<string, unknown>;
  /**
   * `@variable` values. Names are given without the `@`. A variable that is
   * absent (or `undefined`) evaluates to NULL, as in QGIS.
   */
  variables?: Record<string, unknown>;
  /** The feature's geometry in WGS84, for `$x`, `$y` and `$geometry`. */
  geometry?: Geometry | null;
  /** Clock for `now()`; injectable so tests are deterministic. */
  now?: () => Date;
  /** Generator for `uuid()` (bare, without braces); injectable for tests. */
  uuid?: () => string;
  /**
   * Reprojects a `[x, y]` pair for `transform(point, from, to)`. Returning
   * `null` (or leaving this unset) makes `transform` fail, so a default that
   * needs a CRS the host cannot resolve is skipped instead of storing
   * unprojected coordinates under a projected field.
   */
  transform?: (point: [number, number], from: string, to: string) => [number, number] | null;
}

export type QgisExpressionResult = { ok: true; value: unknown } | { ok: false; error: string };

export type QgisExpressionParseResult =
  | { ok: true; node: QgisExpressionNode }
  | { ok: false; error: string };

type Token =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "identifier"; value: string; quoted: boolean }
  | { kind: "variable"; value: string }
  | { kind: "special"; value: string }
  | { kind: "operator"; value: string };

/** Longest expression the parser accepts; form expressions are one-liners. */
const MAX_EXPRESSION_LENGTH = 4000;
/** Nesting bound so a crafted project cannot overflow the stack. */
const MAX_DEPTH = 64;

class QgisExpressionError extends Error {}

/** Backslash escapes QGIS string literals define. */
const STRING_ESCAPES = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ["\\", "\\"],
  ["'", "'"],
]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const readQuoted = (quote: string): string => {
    let value = "";
    i += 1;
    for (;;) {
      if (i >= source.length) throw new QgisExpressionError("Unterminated quoted text");
      const char = source[i];
      if (char === quote) {
        if (source[i + 1] === quote) {
          value += quote;
          i += 2;
          continue;
        }
        i += 1;
        return value;
      }
      if (char === "\\" && quote === "'" && i + 1 < source.length) {
        // Only the escapes QGIS defines are consumed; any other backslash is
        // kept, so a LIKE pattern such as '50\%' still reaches the matcher
        // with its escape intact.
        const next = source[i + 1];
        const escaped = STRING_ESCAPES.get(next);
        if (escaped !== undefined) {
          value += escaped;
          i += 2;
          continue;
        }
      }
      value += char;
      i += 1;
    }
  };
  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (char === "-" && source[i + 1] === "-") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new QgisExpressionError("Unterminated comment");
      i = end + 2;
      continue;
    }
    if (char === "'") {
      tokens.push({ kind: "string", value: readQuoted("'") });
      continue;
    }
    if (char === '"') {
      tokens.push({ kind: "identifier", value: readQuoted('"'), quoted: true });
      continue;
    }
    const number = /^(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(source.slice(i));
    if (number) {
      tokens.push({ kind: "number", value: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    if (char === "@" || char === "$") {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i + 1));
      if (!name) throw new QgisExpressionError(`Unexpected "${char}"`);
      tokens.push({ kind: char === "@" ? "variable" : "special", value: name[0] });
      i += 1 + name[0].length;
      continue;
    }
    const word = /^[A-Za-z_À-￿][A-Za-z0-9_À-￿]*/.exec(source.slice(i));
    if (word) {
      tokens.push({ kind: "identifier", value: word[0], quoted: false });
      i += word[0].length;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (two === "||" || two === "<>" || two === "!=" || two === "<=" || two === ">=") {
      tokens.push({ kind: "operator", value: two === "!=" ? "<>" : two });
      i += 2;
      continue;
    }
    if ("+-*/%^=<>(),".includes(char)) {
      tokens.push({ kind: "operator", value: char });
      i += 1;
      continue;
    }
    throw new QgisExpressionError(`Unexpected "${char}"`);
  }
  return tokens;
}

const KEYWORDS = new Set([
  "and",
  "or",
  "not",
  "is",
  "null",
  "in",
  "like",
  "ilike",
  "true",
  "false",
  "case",
  "when",
  "then",
  "else",
  "end",
]);

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): QgisExpressionNode {
    const node = this.parseOr();
    if (this.index < this.tokens.length) {
      throw new QgisExpressionError(`Unexpected "${this.describe(this.tokens[this.index])}"`);
    }
    return node;
  }

  private describe(token: Token): string {
    return String(token.value);
  }

  private peekKeyword(): string | null {
    const token = this.tokens[this.index];
    if (token?.kind !== "identifier" || token.quoted) return null;
    const lower = token.value.toLowerCase();
    return KEYWORDS.has(lower) ? lower : null;
  }

  private acceptKeyword(keyword: string): boolean {
    if (this.peekKeyword() !== keyword) return false;
    this.index += 1;
    return true;
  }

  private expectKeyword(keyword: string): void {
    if (!this.acceptKeyword(keyword)) {
      throw new QgisExpressionError(`Expected ${keyword.toUpperCase()}`);
    }
  }

  private acceptOperator(...operators: string[]): string | null {
    const token = this.tokens[this.index];
    if (token?.kind !== "operator" || !operators.includes(token.value)) return null;
    this.index += 1;
    return token.value;
  }

  private expectOperator(operator: string): void {
    if (!this.acceptOperator(operator)) throw new QgisExpressionError(`Expected "${operator}"`);
  }

  private nested<T>(parse: () => T): T {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new QgisExpressionError("Expression is nested too deeply");
    try {
      return parse();
    } finally {
      this.depth -= 1;
    }
  }

  private parseOr(): QgisExpressionNode {
    return this.nested(() => {
      let left = this.parseAnd();
      while (this.acceptKeyword("or")) {
        left = { type: "binary", op: "or", left, right: this.parseAnd() };
      }
      return left;
    });
  }

  private parseAnd(): QgisExpressionNode {
    let left = this.parseNot();
    while (this.acceptKeyword("and")) {
      left = { type: "binary", op: "and", left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): QgisExpressionNode {
    if (this.acceptKeyword("not")) {
      return this.nested(() => ({ type: "unary", op: "not", arg: this.parseNot() }));
    }
    return this.parseComparison();
  }

  private parseComparison(): QgisExpressionNode {
    let left = this.parseAdditive();
    for (;;) {
      const operator = this.acceptOperator("=", "<>", "<", "<=", ">", ">=");
      if (operator) {
        left = {
          type: "binary",
          op: operator as QgisBinaryOperator,
          left,
          right: this.parseAdditive(),
        };
        continue;
      }
      if (this.acceptKeyword("is")) {
        const negated = this.acceptKeyword("not");
        this.expectKeyword("null");
        left = { type: "isNull", arg: left, negated };
        continue;
      }
      const start = this.index;
      const negated = this.acceptKeyword("not");
      if (this.acceptKeyword("in")) {
        this.expectOperator("(");
        const list: QgisExpressionNode[] = [];
        if (!this.acceptOperator(")")) {
          do list.push(this.parseOr());
          while (this.acceptOperator(","));
          this.expectOperator(")");
        }
        left = { type: "in", arg: left, list, negated };
        continue;
      }
      const like = this.acceptKeyword("like") ? "like" : this.acceptKeyword("ilike") ? "ilike" : "";
      if (like) {
        const node: QgisExpressionNode = {
          type: "binary",
          op: like,
          left,
          right: this.parseAdditive(),
        };
        left = negated ? { type: "unary", op: "not", arg: node } : node;
        continue;
      }
      this.index = start;
      return left;
    }
  }

  private parseAdditive(): QgisExpressionNode {
    let left = this.parseMultiplicative();
    for (;;) {
      const operator = this.acceptOperator("+", "-");
      if (!operator) return left;
      left = {
        type: "binary",
        op: operator as QgisBinaryOperator,
        left,
        right: this.parseMultiplicative(),
      };
    }
  }

  private parseMultiplicative(): QgisExpressionNode {
    let left = this.parsePower();
    for (;;) {
      const operator = this.acceptOperator("*", "/", "%");
      if (!operator) return left;
      left = {
        type: "binary",
        op: operator as QgisBinaryOperator,
        left,
        right: this.parsePower(),
      };
    }
  }

  private parsePower(): QgisExpressionNode {
    const left = this.parseConcat();
    if (this.acceptOperator("^")) {
      return this.nested(() => ({ type: "binary", op: "^", left, right: this.parsePower() }));
    }
    return left;
  }

  private parseConcat(): QgisExpressionNode {
    let left = this.parseUnary();
    while (this.acceptOperator("||")) {
      left = { type: "binary", op: "||", left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): QgisExpressionNode {
    if (this.acceptOperator("-")) {
      return this.nested(() => ({ type: "unary", op: "-", arg: this.parseUnary() }));
    }
    if (this.acceptOperator("+")) return this.nested(() => this.parseUnary());
    return this.parsePrimary();
  }

  private parsePrimary(): QgisExpressionNode {
    const token = this.tokens[this.index];
    if (!token) throw new QgisExpressionError("Unexpected end of expression");
    if (token.kind === "number" || token.kind === "string") {
      this.index += 1;
      return { type: "literal", value: token.value };
    }
    if (token.kind === "variable") {
      this.index += 1;
      return { type: "variable", name: token.value };
    }
    if (token.kind === "special") {
      this.index += 1;
      return { type: "special", name: token.value.toLowerCase() };
    }
    if (token.kind === "operator") {
      if (token.value !== "(") throw new QgisExpressionError(`Unexpected "${token.value}"`);
      this.index += 1;
      const node = this.parseOr();
      this.expectOperator(")");
      return node;
    }
    if (token.quoted) {
      this.index += 1;
      return { type: "field", name: token.value };
    }
    const keyword = this.peekKeyword();
    if (keyword === "true" || keyword === "false") {
      this.index += 1;
      return { type: "literal", value: keyword === "true" };
    }
    if (keyword === "null") {
      this.index += 1;
      return { type: "literal", value: null };
    }
    if (keyword === "case") {
      this.index += 1;
      const branches: { when: QgisExpressionNode; then: QgisExpressionNode }[] = [];
      while (this.acceptKeyword("when")) {
        const when = this.parseOr();
        this.expectKeyword("then");
        branches.push({ when, then: this.parseOr() });
      }
      if (branches.length === 0) throw new QgisExpressionError("Expected WHEN");
      const otherwise = this.acceptKeyword("else") ? this.parseOr() : null;
      this.expectKeyword("end");
      return { type: "case", branches, otherwise };
    }
    if (keyword) throw new QgisExpressionError(`Unexpected "${token.value}"`);
    this.index += 1;
    if (this.acceptOperator("(")) {
      const args: QgisExpressionNode[] = [];
      if (!this.acceptOperator(")")) {
        do args.push(this.parseOr());
        while (this.acceptOperator(","));
        this.expectOperator(")");
      }
      return { type: "call", name: token.value.toLowerCase(), args };
    }
    // A bare word that is not a call is a field reference, as in QGIS.
    return { type: "field", name: token.value };
  }
}

/**
 * Parse a QGIS expression into an AST.
 *
 * @param source - The expression text.
 * @returns The AST, or the first syntax error.
 */
export function parseQgisExpression(source: string): QgisExpressionParseResult {
  if (source.length > MAX_EXPRESSION_LENGTH) return { ok: false, error: "Expression is too long" };
  try {
    const tokens = tokenize(source);
    if (tokens.length === 0) return { ok: false, error: "Expression is empty" };
    return { ok: true, node: new Parser(tokens).parse() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

interface PointValue {
  type: "Point";
  coordinates: number[];
}

function isPoint(value: unknown): value is PointValue {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "Point" &&
    Array.isArray((value as { coordinates?: unknown }).coordinates)
  );
}

function isNull(value: unknown): boolean {
  return (
    value === null || value === undefined || (typeof value === "number" && Number.isNaN(value))
  );
}

function pad(value: number, width: number): string {
  return String(Math.trunc(Math.abs(value))).padStart(width, "0");
}

/** The local-time ISO form QGIS writes for a datetime (`2026-11-11T16:05:09`). */
export function formatQgisDateTime(date: Date): string {
  return `${formatQgisDate(date)}T${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}`;
}

/** The local-time ISO date (`2026-11-11`). */
export function formatQgisDate(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

function toText(value: unknown): string {
  if (value instanceof Date) return formatQgisDateTime(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (isPoint(value)) return `POINT(${value.coordinates.join(" ")})`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new QgisExpressionError(`Cannot convert "${toText(value)}" to a number`);
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    // `new Date("2026-11-11")` is midnight UTC, which is the previous day in
    // any zone west of Greenwich once read back with local getters. A value
    // without a zone is a local calendar date/time, as it is in QGIS.
    const local =
      /^\s*(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?\s*$/.exec(
        value,
      );
    if (local) {
      const [, year, month, day, hour = "0", minute = "0", second = "0", ms = "0"] = local;
      const parsed = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        Number(ms.padEnd(3, "0")),
      );
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new QgisExpressionError(`Cannot convert "${toText(value)}" to a date`);
}

/** Three-valued truthiness: `null` stays unknown. */
function toBoolean(value: unknown): boolean | null {
  if (isNull(value)) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "" || lower === "false" || lower === "0") return false;
    return true;
  }
  return true;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Render a date with a Qt format string (`yyyy-MM-dd HH:mm:ss`, …). */
function formatQtDate(date: Date, format: string): string {
  const hours = date.getHours();
  const twelveHour = /(?:ap|a)/i.test(format.replace(/'[^']*'/g, ""));
  const replacements: Record<string, () => string> = {
    yyyy: () => pad(date.getFullYear(), 4),
    yy: () => pad(date.getFullYear() % 100, 2),
    MMMM: () => MONTHS[date.getMonth()],
    MMM: () => MONTHS[date.getMonth()].slice(0, 3),
    MM: () => pad(date.getMonth() + 1, 2),
    M: () => String(date.getMonth() + 1),
    dddd: () => DAYS[date.getDay()],
    ddd: () => DAYS[date.getDay()].slice(0, 3),
    dd: () => pad(date.getDate(), 2),
    d: () => String(date.getDate()),
    HH: () => pad(hours, 2),
    H: () => String(hours),
    hh: () => pad(twelveHour ? hours % 12 || 12 : hours, 2),
    h: () => String(twelveHour ? hours % 12 || 12 : hours),
    mm: () => pad(date.getMinutes(), 2),
    m: () => String(date.getMinutes()),
    ss: () => pad(date.getSeconds(), 2),
    s: () => String(date.getSeconds()),
    zzz: () => pad(date.getMilliseconds(), 3),
    z: () => String(date.getMilliseconds()),
    AP: () => (hours < 12 ? "AM" : "PM"),
    ap: () => (hours < 12 ? "am" : "pm"),
    A: () => (hours < 12 ? "AM" : "PM"),
    a: () => (hours < 12 ? "am" : "pm"),
  };
  return format.replace(
    /'([^']*)'|yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|zzz|z|AP|ap|A|a/g,
    (match, quoted: string | undefined) =>
      quoted !== undefined ? quoted || "'" : replacements[match](),
  );
}

function pointOf(value: unknown, name: string): PointValue {
  if (isPoint(value)) return value;
  throw new QgisExpressionError(`${name}() needs a point`);
}

function defaultUuid(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  // Non-secure contexts (plain-HTTP self-hosting) have no randomUUID.
  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Longest text a function may build; a default value is a short string. */
const MAX_TEXT_LENGTH = 10_000;

function padWidth(value: unknown): number {
  const width = Math.max(0, Math.trunc(toNumber(value)));
  if (width > MAX_TEXT_LENGTH) throw new QgisExpressionError("The padded text is too long");
  return width;
}

type QgisFunction = (args: unknown[], context: QgisExpressionContext) => unknown;

interface FunctionSpec {
  min: number;
  max: number;
  /** When false (the default) any NULL argument makes the result NULL. */
  handlesNull?: boolean;
  run: QgisFunction;
}

const text = (run: (value: string, args: unknown[]) => unknown, max = 1): FunctionSpec => ({
  min: 1,
  max,
  run: (args) => run(toText(args[0]), args),
});

const numeric = (run: (value: number) => number): FunctionSpec => ({
  min: 1,
  max: 1,
  run: (args) => run(toNumber(args[0])),
});

/** Every callable function; the whole surface an imported expression can reach. */
const FUNCTIONS: Record<string, FunctionSpec> = {
  now: { min: 0, max: 0, run: (_args, context) => context.now?.() ?? new Date() },
  uuid: {
    min: 0,
    max: 1,
    run: (args, context) => {
      const id = context.uuid?.() ?? defaultUuid();
      const format = args.length > 0 ? toText(args[0]).toLowerCase() : "withbraces";
      if (format === "withoutbraces") return id;
      if (format === "id128") return id.replaceAll("-", "");
      return `{${id}}`;
    },
  },
  coalesce: {
    min: 0,
    max: Infinity,
    handlesNull: true,
    run: (args) => args.find((arg) => !isNull(arg)) ?? null,
  },
  concat: {
    min: 0,
    max: Infinity,
    handlesNull: true,
    run: (args) => args.map((arg) => (isNull(arg) ? "" : toText(arg))).join(""),
  },
  if: {
    min: 3,
    max: 3,
    handlesNull: true,
    run: (args) => (toBoolean(args[0]) === true ? args[1] : args[2]),
  },
  nullif: {
    min: 2,
    max: 2,
    handlesNull: true,
    run: (args) => (compare(args[0], args[1]) === 0 ? null : args[0]),
  },
  to_string: { min: 1, max: 1, run: (args) => toText(args[0]) },
  to_int: { min: 1, max: 1, run: (args) => Math.trunc(toNumber(args[0])) },
  to_real: { min: 1, max: 1, run: (args) => toNumber(args[0]) },
  to_date: { min: 1, max: 1, run: (args) => formatQgisDate(toDate(args[0])) },
  to_datetime: { min: 1, max: 1, run: (args) => toDate(args[0]) },
  upper: text((value) => value.toUpperCase()),
  lower: text((value) => value.toLowerCase()),
  trim: text((value) => value.trim()),
  title: text((value) =>
    value.replace(/\S+/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase()),
  ),
  length: text((value) => value.length),
  char_length: text((value) => value.length),
  left: text((value, args) => value.slice(0, Math.max(0, toNumber(args[1]))), 2),
  right: text((value, args) => {
    const count = Math.max(0, toNumber(args[1]));
    return count === 0 ? "" : value.slice(-count);
  }, 2),
  substr: {
    min: 2,
    max: 3,
    run: (args) => {
      const value = toText(args[0]);
      // 1-based start; a negative start counts from the end, as in QGIS.
      const position = Math.trunc(toNumber(args[1]));
      const start = position > 0 ? position - 1 : Math.max(0, value.length + position);
      if (args.length < 3) return value.slice(start);
      return value.slice(start, start + Math.max(0, Math.trunc(toNumber(args[2]))));
    },
  },
  replace: {
    min: 3,
    max: 3,
    run: (args) => {
      // Splitting on "" would insert the replacement between every character;
      // QGIS leaves the text as it is.
      const search = toText(args[1]);
      return search ? toText(args[0]).split(search).join(toText(args[2])) : toText(args[0]);
    },
  },
  lpad: {
    min: 3,
    max: 3,
    run: (args) => {
      const width = padWidth(args[1]);
      return toText(args[0])
        .slice(0, width)
        .padStart(width, toText(args[2]) || " ");
    },
  },
  rpad: {
    min: 3,
    max: 3,
    run: (args) => {
      const width = padWidth(args[1]);
      return toText(args[0])
        .slice(0, width)
        .padEnd(width, toText(args[2]) || " ");
    },
  },
  abs: numeric(Math.abs),
  floor: numeric(Math.floor),
  ceil: numeric(Math.ceil),
  sqrt: numeric(Math.sqrt),
  round: {
    min: 1,
    max: 2,
    run: (args) => {
      const factor = 10 ** (args.length > 1 ? Math.trunc(toNumber(args[1])) : 0);
      return Math.round(toNumber(args[0]) * factor) / factor;
    },
  },
  min: { min: 1, max: Infinity, run: (args) => Math.min(...args.map(toNumber)) },
  max: { min: 1, max: Infinity, run: (args) => Math.max(...args.map(toNumber)) },
  format_number: {
    min: 1,
    max: 2,
    run: (args) => toNumber(args[0]).toFixed(args.length > 1 ? Math.trunc(toNumber(args[1])) : 0),
  },
  format_date: {
    min: 2,
    max: 2,
    run: (args) => formatQtDate(toDate(args[0]), toText(args[1])),
  },
  year: { min: 1, max: 1, run: (args) => toDate(args[0]).getFullYear() },
  month: { min: 1, max: 1, run: (args) => toDate(args[0]).getMonth() + 1 },
  day: { min: 1, max: 1, run: (args) => toDate(args[0]).getDate() },
  hour: { min: 1, max: 1, run: (args) => toDate(args[0]).getHours() },
  minute: { min: 1, max: 1, run: (args) => toDate(args[0]).getMinutes() },
  second: { min: 1, max: 1, run: (args) => toDate(args[0]).getSeconds() },
  epoch: { min: 1, max: 1, run: (args) => toDate(args[0]).getTime() },
  x: { min: 1, max: 1, run: (args) => pointOf(args[0], "x").coordinates[0] ?? null },
  y: { min: 1, max: 1, run: (args) => pointOf(args[0], "y").coordinates[1] ?? null },
  z: { min: 1, max: 1, run: (args) => pointOf(args[0], "z").coordinates[2] ?? null },
  make_point: {
    min: 2,
    max: 3,
    run: (args): PointValue => ({ type: "Point", coordinates: args.map(toNumber) }),
  },
  transform: {
    min: 3,
    max: 3,
    run: (args, context): PointValue => {
      const point = pointOf(args[0], "transform");
      const [x, y, ...rest] = point.coordinates;
      const from = toText(args[1]);
      const to = toText(args[2]);
      const projected =
        from.toUpperCase() === to.toUpperCase()
          ? ([x, y] as [number, number])
          : (context.transform?.([x, y], from, to) ?? null);
      if (!projected || !projected.every(Number.isFinite)) {
        throw new QgisExpressionError(`Cannot transform from ${from} to ${to}`);
      }
      return { type: "Point", coordinates: [...projected, ...rest] };
    },
  },
  // attribute('name'): the current feature's own attribute. The two-argument
  // form takes a feature fetched from another layer, which is out of scope.
  attribute: {
    min: 1,
    max: 1,
    run: (args, context) => {
      const name = toText(args[0]);
      return context.properties && Object.prototype.hasOwnProperty.call(context.properties, name)
        ? (context.properties[name] ?? null)
        : null;
    },
  },
};

/** Alternate spellings QGIS accepts for the same function. */
const FUNCTION_ALIASES: Record<string, string> = {
  tostring: "to_string",
  toint: "to_int",
  toreal: "to_real",
  todate: "to_date",
  todatetime: "to_datetime",
};

function resolveFunction(name: string): FunctionSpec | undefined {
  const canonical = FUNCTION_ALIASES[name] ?? name;
  return Object.prototype.hasOwnProperty.call(FUNCTIONS, canonical)
    ? FUNCTIONS[canonical]
    : undefined;
}

/** -1/0/1 ordering; numbers numerically when both sides are numeric. */
function compare(left: unknown, right: unknown): number {
  const a = left instanceof Date ? left.getTime() : left;
  const b = right instanceof Date ? right.getTime() : right;
  if (typeof a === "boolean" || typeof b === "boolean") {
    const x = toBoolean(a) ? 1 : 0;
    const y = toBoolean(b) ? 1 : 0;
    return x === y ? 0 : x < y ? -1 : 1;
  }
  const numericPair =
    (typeof a === "number" ||
      (typeof a === "string" && a.trim() !== "" && Number.isFinite(Number(a)))) &&
    (typeof b === "number" ||
      (typeof b === "string" && b.trim() !== "" && Number.isFinite(Number(b)))) &&
    (typeof a === "number" || typeof b === "number");
  if (numericPair) {
    const x = Number(a);
    const y = Number(b);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  const x = toText(a);
  const y = toText(b);
  return x === y ? 0 : x < y ? -1 : 1;
}

/**
 * SQL LIKE: `%` matches any run of characters, `_` exactly one, and a
 * backslash makes the next character literal. Matched with the two-pointer
 * wildcard walk rather than a generated `RegExp`, so a pattern from an
 * imported project cannot trigger catastrophic backtracking.
 */
function matchesLike(text: string, pattern: string, caseInsensitive: boolean): boolean {
  const tokens: { kind: "any" | "one" | "char"; char?: string }[] = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "\\" && i + 1 < pattern.length) {
      i += 1;
      tokens.push({ kind: "char", char: pattern[i] });
    } else if (char === "%") {
      if (tokens[tokens.length - 1]?.kind !== "any") tokens.push({ kind: "any" });
    } else if (char === "_") tokens.push({ kind: "one" });
    else tokens.push({ kind: "char", char });
  }
  const subject = caseInsensitive ? text.toLowerCase() : text;
  const same = (token: { char?: string }, char: string) =>
    (caseInsensitive ? token.char!.toLowerCase() : token.char) === char;
  let t = 0;
  let p = 0;
  let star = -1;
  let mark = 0;
  while (t < subject.length) {
    const token = tokens[p];
    if (token && (token.kind === "one" || (token.kind === "char" && same(token, subject[t])))) {
      t += 1;
      p += 1;
    } else if (token?.kind === "any") {
      star = p;
      mark = t;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (tokens[p]?.kind === "any") p += 1;
  return p === tokens.length;
}

function evaluateNode(node: QgisExpressionNode, context: QgisExpressionContext): unknown {
  switch (node.type) {
    case "literal":
      return node.value;
    case "field": {
      const properties = context.properties;
      if (properties && Object.prototype.hasOwnProperty.call(properties, node.name)) {
        return properties[node.name] ?? null;
      }
      return null;
    }
    case "variable": {
      const variables = context.variables;
      if (variables && Object.prototype.hasOwnProperty.call(variables, node.name)) {
        return variables[node.name] ?? null;
      }
      return null;
    }
    case "special": {
      const geometry = context.geometry ?? null;
      if (node.name === "geometry") return geometry;
      if (node.name === "x" || node.name === "y") {
        if (!isPoint(geometry)) return null;
        return geometry.coordinates[node.name === "x" ? 0 : 1] ?? null;
      }
      if (node.name === "now") return context.now?.() ?? new Date();
      throw new QgisExpressionError(`$${node.name} is not supported`);
    }
    case "call": {
      const spec = resolveFunction(node.name);
      if (!spec) throw new QgisExpressionError(`The function ${node.name}() is not supported`);
      if (node.args.length < spec.min || node.args.length > spec.max) {
        throw new QgisExpressionError(`Wrong number of arguments for ${node.name}()`);
      }
      // Only the chosen branch runs, as in QGIS, so a guarded branch that
      // would fail (`if("a" is null, 0, to_int("a"))`) cannot sink the result.
      if (node.name === "if") {
        const chosen = toBoolean(evaluateNode(node.args[0], context)) === true ? 1 : 2;
        return evaluateNode(node.args[chosen], context);
      }
      const args = node.args.map((arg) => evaluateNode(arg, context));
      if (!spec.handlesNull && args.some(isNull)) return null;
      return spec.run(args, context);
    }
    case "unary": {
      const value = evaluateNode(node.arg, context);
      if (node.op === "not") {
        const truth = toBoolean(value);
        return truth === null ? null : !truth;
      }
      return isNull(value) ? null : -toNumber(value);
    }
    case "isNull":
      return isNull(evaluateNode(node.arg, context)) !== node.negated;
    case "in": {
      const value = evaluateNode(node.arg, context);
      if (isNull(value)) return null;
      const found = node.list.some((entry) => {
        const candidate = evaluateNode(entry, context);
        return !isNull(candidate) && compare(value, candidate) === 0;
      });
      return found !== node.negated;
    }
    case "case": {
      for (const branch of node.branches) {
        if (toBoolean(evaluateNode(branch.when, context)) === true) {
          return evaluateNode(branch.then, context);
        }
      }
      return node.otherwise ? evaluateNode(node.otherwise, context) : null;
    }
    case "binary":
      return evaluateBinary(node, context);
  }
}

function evaluateBinary(
  node: Extract<QgisExpressionNode, { type: "binary" }>,
  context: QgisExpressionContext,
): unknown {
  if (node.op === "and" || node.op === "or") {
    const left = toBoolean(evaluateNode(node.left, context));
    if (node.op === "and" && left === false) return false;
    if (node.op === "or" && left === true) return true;
    const right = toBoolean(evaluateNode(node.right, context));
    if (node.op === "and") return right === false ? false : left === null ? null : right;
    return right === true ? true : left === null ? null : right;
  }
  const left = evaluateNode(node.left, context);
  const right = evaluateNode(node.right, context);
  if (isNull(left) || isNull(right)) return null;
  switch (node.op) {
    case "||":
      return toText(left) + toText(right);
    case "=":
      return compare(left, right) === 0;
    case "<>":
      return compare(left, right) !== 0;
    case "<":
      return compare(left, right) < 0;
    case "<=":
      return compare(left, right) <= 0;
    case ">":
      return compare(left, right) > 0;
    case ">=":
      return compare(left, right) >= 0;
    case "like":
    case "ilike":
      return matchesLike(toText(left), toText(right), node.op === "ilike");
    case "+":
      // QGIS concatenates when either side is text that is not a number.
      if (
        (typeof left === "string" && !Number.isFinite(Number(left))) ||
        (typeof right === "string" && !Number.isFinite(Number(right)))
      ) {
        return toText(left) + toText(right);
      }
      return toNumber(left) + toNumber(right);
    case "-":
      return toNumber(left) - toNumber(right);
    case "*":
      return toNumber(left) * toNumber(right);
    case "/": {
      const divisor = toNumber(right);
      return divisor === 0 ? null : toNumber(left) / divisor;
    }
    case "%": {
      const divisor = toNumber(right);
      return divisor === 0 ? null : toNumber(left) % divisor;
    }
    case "^":
      return toNumber(left) ** toNumber(right);
  }
}

/**
 * Evaluate a QGIS expression.
 *
 * @param source - Expression text, or an AST from {@link parseQgisExpression}.
 * @param context - Field values, variables, geometry and injectable clock.
 * @returns The value (possibly `null`), or why it could not be computed.
 */
export function evaluateQgisExpression(
  source: string | QgisExpressionNode,
  context: QgisExpressionContext = {},
): QgisExpressionResult {
  let node: QgisExpressionNode;
  if (typeof source === "string") {
    const parsed = parseQgisExpression(source);
    if (!parsed.ok) return parsed;
    node = parsed.node;
  } else {
    node = source;
  }
  try {
    const value = evaluateNode(node, context);
    return { ok: true, value: value === undefined ? null : value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** MapLibre operators that map one-to-one onto a QGIS binary operator. */
const MAPLIBRE_BINARY: Partial<Record<QgisBinaryOperator, string>> = {
  "=": "==",
  "<>": "!=",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  "%": "%",
  "^": "^",
  and: "all",
  or: "any",
};

type OperandKind = "number" | "string" | "boolean" | "unknown";

function operandKind(node: QgisExpressionNode): OperandKind {
  if (node.type === "literal") {
    if (typeof node.value === "number") return "number";
    if (typeof node.value === "string") return "string";
    if (typeof node.value === "boolean") return "boolean";
    return "unknown";
  }
  if (node.type === "unary") return node.op === "-" ? "number" : "boolean";
  if (node.type === "binary") {
    if (["+", "-", "*", "/", "%", "^"].includes(node.op)) return "number";
    if (node.op === "||") return "string";
    return "boolean";
  }
  if (node.type === "call") {
    if (["length", "char_length", "abs", "floor", "ceil", "round", "sqrt"].includes(node.name)) {
      return "number";
    }
    if (["upper", "lower", "trim", "concat", "to_string", "tostring"].includes(node.name)) {
      return "string";
    }
  }
  return "unknown";
}

function translate(node: QgisExpressionNode): unknown {
  switch (node.type) {
    case "literal":
      return node.value;
    case "field":
      return ["get", node.name];
    case "unary":
      return node.op === "not" ? ["!", translate(node.arg)] : ["-", translate(node.arg)];
    case "isNull": {
      // A missing property and an explicit null are both NULL to QGIS.
      const test = ["==", translate(node.arg), null];
      return node.negated ? ["!", test] : test;
    }
    case "in": {
      if (!node.list.every((entry) => entry.type === "literal" && entry.value !== null)) {
        throw new QgisExpressionError("IN needs literal values");
      }
      const test = [
        "in",
        translate(node.arg),
        ["literal", node.list.map((entry) => (entry as { value: unknown }).value)],
      ];
      return node.negated ? ["!", test] : test;
    }
    case "binary": {
      if (node.op === "||") {
        return ["concat", translate(node.left), translate(node.right)];
      }
      const operator = MAPLIBRE_BINARY[node.op];
      if (!operator) throw new QgisExpressionError(`${node.op.toUpperCase()} is not supported`);
      if (operator === "all" || operator === "any") {
        return [operator, translate(node.left), translate(node.right)];
      }
      // MapLibre comparisons and arithmetic are strictly typed, while a
      // feature property is untyped: coerce a field reference to the type of
      // the literal it is compared with so `"boxes" <= 10` type-checks.
      const leftKind = operandKind(node.left);
      const rightKind = operandKind(node.right);
      const arithmetic = ["+", "-", "*", "/", "%", "^"].includes(operator);
      const target: OperandKind = arithmetic
        ? "number"
        : leftKind !== "unknown"
          ? leftKind
          : rightKind;
      const coerce = (side: QgisExpressionNode, kind: OperandKind): unknown => {
        const translated = translate(side);
        if (kind !== "unknown" || target === "unknown" || target === "boolean") return translated;
        return [target === "number" ? "to-number" : "to-string", translated];
      };
      return [operator, coerce(node.left, leftKind), coerce(node.right, rightKind)];
    }
    case "call": {
      const args = node.args.map(translate);
      const arity = (count: number): void => {
        if (args.length !== count) {
          throw new QgisExpressionError(`Wrong number of arguments for ${node.name}()`);
        }
      };
      switch (FUNCTION_ALIASES[node.name] ?? node.name) {
        case "length":
        case "char_length":
          arity(1);
          return ["length", ["to-string", ["coalesce", args[0], ""]]];
        case "upper":
          arity(1);
          return ["upcase", ["to-string", args[0]]];
        case "lower":
          arity(1);
          return ["downcase", ["to-string", args[0]]];
        case "to_string":
          arity(1);
          return ["to-string", args[0]];
        // to_int() truncates, which `to-number` does not, so it is left to the
        // default case and reported as not convertible.
        case "to_real":
          arity(1);
          return ["to-number", args[0]];
        case "abs":
        case "floor":
        case "ceil":
        case "sqrt":
          arity(1);
          return [node.name, ["to-number", args[0]]];
        case "round":
          arity(1);
          return ["round", ["to-number", args[0]]];
        case "coalesce":
          return ["coalesce", ...args];
        case "concat":
          return ["concat", ...args];
        default:
          throw new QgisExpressionError(`The function ${node.name}() is not supported`);
      }
    }
    default:
      throw new QgisExpressionError("This expression cannot be converted");
  }
}

/**
 * Convert a boolean QGIS expression (a form constraint) into the MapLibre
 * expression source an {@link AttributeFormFieldConfig.constraintExpression}
 * stores. Only field references, literals, comparison, boolean logic,
 * arithmetic and a few string/number functions convert; anything else
 * (variables, dates, geometry) returns `null` so the importer can report the
 * constraint as not carried over instead of installing a wrong rule.
 *
 * @param source - QGIS constraint expression.
 * @returns JSON source of an equivalent MapLibre expression, or `null`.
 */
export function qgisExpressionToMapLibre(source: string): string | null {
  const parsed = parseQgisExpression(source);
  if (!parsed.ok) return null;
  try {
    const expression = translate(parsed.node);
    return Array.isArray(expression) ? JSON.stringify(expression) : null;
  } catch {
    return null;
  }
}

function collectUnsupported(node: QgisExpressionNode, found: Set<string>): void {
  switch (node.type) {
    case "literal":
    case "field":
    case "variable":
      return;
    case "special":
      if (!["geometry", "x", "y", "now"].includes(node.name)) found.add(`$${node.name}`);
      return;
    case "call":
      if (!resolveFunction(node.name)) found.add(`${node.name}()`);
      else if (
        node.args.length < resolveFunction(node.name)!.min ||
        node.args.length > resolveFunction(node.name)!.max
      ) {
        found.add(`${node.name}()`);
      }
      node.args.forEach((arg) => collectUnsupported(arg, found));
      return;
    case "unary":
    case "isNull":
      collectUnsupported(node.arg, found);
      return;
    case "in":
      collectUnsupported(node.arg, found);
      node.list.forEach((entry) => collectUnsupported(entry, found));
      return;
    case "case":
      for (const branch of node.branches) {
        collectUnsupported(branch.when, found);
        collectUnsupported(branch.then, found);
      }
      if (node.otherwise) collectUnsupported(node.otherwise, found);
      return;
    case "binary":
      collectUnsupported(node.left, found);
      collectUnsupported(node.right, found);
  }
}

/**
 * Check, without evaluating, whether an expression stays inside the supported
 * subset. An importer uses this to decide up front whether a default value
 * can be carried over, rather than installing one that can never produce a
 * value.
 *
 * @param source - QGIS expression text.
 * @returns `null` when the expression is usable; otherwise the syntax error,
 *   or the functions and `$` variables it uses that are not supported.
 */
export function qgisExpressionProblem(source: string): string | null {
  const parsed = parseQgisExpression(source);
  if (!parsed.ok) return parsed.error;
  const found = new Set<string>();
  collectUnsupported(parsed.node, found);
  return found.size > 0 ? [...found].join(", ") : null;
}

/** Bit flags {@link collectReferences} returns. */
const USES_NOW = 1;
const USES_UUID = 2;

function collectReferences(node: QgisExpressionNode, fields: Set<string>): number {
  switch (node.type) {
    case "literal":
    case "variable":
      return 0;
    case "special":
      return node.name === "now" ? USES_NOW : 0;
    case "field":
      fields.add(node.name);
      return 0;
    case "call": {
      let volatile = node.name === "now" ? USES_NOW : node.name === "uuid" ? USES_UUID : 0;
      // attribute('name') reads a field by a name only known when it runs.
      if (node.name === "attribute") {
        const [name] = node.args;
        if (name?.type === "literal" && typeof name.value === "string") fields.add(name.value);
        else fields.add("*");
      }
      for (const arg of node.args) volatile |= collectReferences(arg, fields);
      return volatile;
    }
    case "unary":
    case "isNull":
      return collectReferences(node.arg, fields);
    case "in": {
      let volatile = collectReferences(node.arg, fields);
      for (const entry of node.list) volatile |= collectReferences(entry, fields);
      return volatile;
    }
    case "case": {
      let volatile = 0;
      for (const branch of node.branches) {
        volatile |= collectReferences(branch.when, fields);
        volatile |= collectReferences(branch.then, fields);
      }
      if (node.otherwise) volatile |= collectReferences(node.otherwise, fields);
      return volatile;
    }
    case "binary":
      return collectReferences(node.left, fields) | collectReferences(node.right, fields);
  }
}

/** What an expression reads, for deciding when its value needs recomputing. */
export interface QgisExpressionReferences {
  /** Field names it reads; `"*"` when a name is only known at run time. */
  fields: string[];
  /** Whether it reads the clock (`now()`), which a caller can hold still. */
  usesNow: boolean;
  /** Whether it calls `uuid()`, whose value differs on every run. */
  usesUuid: boolean;
}

/**
 * List the fields an expression reads and whether its result changes between
 * runs with the same inputs.
 *
 * @param source - QGIS expression text.
 * @returns The references, or `null` when the expression does not parse.
 */
export function qgisExpressionReferences(source: string): QgisExpressionReferences | null {
  const parsed = parseQgisExpression(source);
  if (!parsed.ok) return null;
  const fields = new Set<string>();
  const flags = collectReferences(parsed.node, fields);
  return {
    fields: [...fields],
    usesNow: (flags & USES_NOW) !== 0,
    usesUuid: (flags & USES_UUID) !== 0,
  };
}
