/**
 * CSP-safe, zero-`eval` recursive-descent expression parser and compiler for
 * multi-raster band math (`A`, `A1`, `B`, `B2`, `C`, ...).
 *
 * Compiles an expression once into a flat closure tree that reads directly from
 * typed band arrays by pixel index with zero per-pixel array allocations.
 */

export interface BandRef {
  /** Uppercase raster letter (`"A"`, `"B"`, `"C"`, ...). */
  raster: string;
  /** 1-based band index. */
  band: number;
  /** Original reference token (e.g. `"A"`, `"B2"`). */
  raw: string;
}

export interface CompiledRasterExpression {
  /** Every distinct band reference actually used by the expression. */
  referencedBands: BandRef[];
  /** Evaluate the expression at pixel index `pixelIndex`. */
  evaluate: (pixelIndex: number) => number;
}

type TokenKind = "number" | "ident" | "op" | "lparen" | "rparen" | "comma" | "eof";

interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

const MAX_DEPTH = 64;
const MAX_NODES = 1024;

const ALLOWED_FUNCTIONS: Readonly<Record<string, { minArgs: number; maxArgs: number }>> = {
  where: { minArgs: 3, maxArgs: 3 },
  clip: { minArgs: 3, maxArgs: 3 },
  log: { minArgs: 1, maxArgs: 1 },
  exp: { minArgs: 1, maxArgs: 1 },
  sqrt: { minArgs: 1, maxArgs: 1 },
  abs: { minArgs: 1, maxArgs: 1 },
  minimum: { minArgs: 2, maxArgs: 2 },
  maximum: { minArgs: 2, maxArgs: 2 },
  min: { minArgs: 2, maxArgs: 16 },
  max: { minArgs: 2, maxArgs: 16 },
  sin: { minArgs: 1, maxArgs: 1 },
  cos: { minArgs: 1, maxArgs: 1 },
  tan: { minArgs: 1, maxArgs: 1 },
  pow: { minArgs: 2, maxArgs: 2 },
  floor: { minArgs: 1, maxArgs: 1 },
  ceil: { minArgs: 1, maxArgs: 1 },
  round: { minArgs: 1, maxArgs: 1 },
};

const BAND_REF_RE = /^([A-Z])(\d*)$/;

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = expr.length;

  while (i < n) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    // Numeric literal (supports leading-dot decimals like .5 and scientific notation)
    if (/\d/.test(ch) || (ch === "." && i + 1 < n && /\d/.test(expr[i + 1]))) {
      const start = i;
      while (i < n && /\d/.test(expr[i])) i += 1;
      if (i < n && expr[i] === ".") {
        i += 1;
        while (i < n && /\d/.test(expr[i])) i += 1;
      }
      if (i < n && (expr[i] === "e" || expr[i] === "E")) {
        const expStart = i;
        i += 1;
        if (i < n && (expr[i] === "+" || expr[i] === "-")) i += 1;
        const digitsStart = i;
        while (i < n && /\d/.test(expr[i])) i += 1;
        if (i === digitsStart) {
          throw new Error(`Invalid numeric literal at position ${expStart}.`);
        }
      }
      tokens.push({ kind: "number", value: expr.slice(start, i), pos: start });
      continue;
    }

    // Identifier (band ref or function name)
    if (/[A-Za-z$_]/.test(ch)) {
      const start = i;
      while (i < n && /[A-Za-z0-9$_]/.test(expr[i])) i += 1;
      const ident = expr.slice(start, i);
      if (
        !Object.prototype.hasOwnProperty.call(ALLOWED_FUNCTIONS, ident) &&
        !BAND_REF_RE.test(ident)
      ) {
        throw new Error(
          `Expression contains unsupported identifiers ("${ident}"). Only raster bands (A, B, C, A1, B2 ...) and the math helpers ` +
            "(where, clip, log, exp, sqrt, abs, minimum, maximum, min, max, sin, cos, tan, pow, floor, ceil, round) are allowed.",
        );
      }
      tokens.push({ kind: "ident", value: ident, pos: start });
      continue;
    }

    if (ch === "(") {
      tokens.push({ kind: "lparen", value: ch, pos: i });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen", value: ch, pos: i });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "comma", value: ch, pos: i });
      i += 1;
      continue;
    }

    // Multi-character operators
    const two = expr.slice(i, i + 2);
    if (
      two === "**" ||
      two === "<=" ||
      two === ">=" ||
      two === "==" ||
      two === "!=" ||
      two === "&&" ||
      two === "||"
    ) {
      tokens.push({ kind: "op", value: two, pos: i });
      i += 2;
      continue;
    }

    // Single-character operators
    if ("+-*/%<>!&|".includes(ch)) {
      tokens.push({ kind: "op", value: ch, pos: i });
      i += 1;
      continue;
    }

    throw new Error(
      "Expression contains unsupported characters. Only raster bands (A, B, C, A1, B2 ...), " +
        "math helpers, numbers, and arithmetic/comparison operators are allowed.",
    );
  }

  tokens.push({ kind: "eof", value: "", pos: n });
  return tokens;
}

type EvalNode = (pixelIndex: number) => number;

/**
 * Compile a raster calculator expression against the available raster band arrays.
 *
 * `rasters` maps uppercase raster letters (always `"A"`, optionally `"B"`, `"C"`, ...)
 * to their band arrays (`Float32Array[]`).
 */
export function compileRasterExpression(
  expression: string,
  rasters: Readonly<Record<string, readonly Float32Array[]>>,
): CompiledRasterExpression {
  const expr = expression.trim();
  if (!expr) throw new Error("Enter an expression.");

  const tokens = tokenize(expr);
  let cursor = 0;
  let depth = 0;
  let nodeCount = 0;
  const referencedMap = new Map<string, BandRef>();

  const peek = (): Token => tokens[cursor];
  const consume = (): Token => tokens[cursor++];
  const countNode = (): void => {
    nodeCount += 1;
    if (nodeCount > MAX_NODES) {
      throw new Error("Expression is too complex.");
    }
  };

  const withDepth = <T>(fn: () => T): T => {
    depth += 1;
    if (depth > MAX_DEPTH) {
      throw new Error("Expression is nested too deeply.");
    }
    try {
      return fn();
    } finally {
      depth -= 1;
    }
  };

  function parseOr(): EvalNode {
    const first = parseAnd();
    if (peek().kind !== "op" || peek().value !== "||") return first;
    const terms: EvalNode[] = [first];
    while (peek().kind === "op" && peek().value === "||") {
      consume();
      countNode();
      terms.push(parseAnd());
    }
    return (p) => {
      let acc = terms[0](p);
      for (let i = 1; i < terms.length; i += 1) {
        if (acc) return acc;
        acc = terms[i](p);
      }
      return acc;
    };
  }

  function parseAnd(): EvalNode {
    const first = parseBitOr();
    if (peek().kind !== "op" || peek().value !== "&&") return first;
    const terms: EvalNode[] = [first];
    while (peek().kind === "op" && peek().value === "&&") {
      consume();
      countNode();
      terms.push(parseBitOr());
    }
    return (p) => {
      let acc = terms[0](p);
      for (let i = 1; i < terms.length; i += 1) {
        if (!acc) return acc;
        acc = terms[i](p);
      }
      return acc;
    };
  }

  function parseBitOr(): EvalNode {
    const first = parseBitAnd();
    if (peek().kind !== "op" || peek().value !== "|") return first;
    const terms: EvalNode[] = [first];
    while (peek().kind === "op" && peek().value === "|") {
      consume();
      countNode();
      terms.push(parseBitAnd());
    }
    return (p) => {
      let acc = terms[0](p);
      for (let i = 1; i < terms.length; i += 1) {
        acc = acc | terms[i](p);
      }
      return acc;
    };
  }

  function parseBitAnd(): EvalNode {
    const first = parseEquality();
    if (peek().kind !== "op" || peek().value !== "&") return first;
    const terms: EvalNode[] = [first];
    while (peek().kind === "op" && peek().value === "&") {
      consume();
      countNode();
      terms.push(parseEquality());
    }
    return (p) => {
      let acc = terms[0](p);
      for (let i = 1; i < terms.length; i += 1) {
        acc = acc & terms[i](p);
      }
      return acc;
    };
  }

  function parseEquality(): EvalNode {
    const first = parseRelational();
    if (peek().kind !== "op" || (peek().value !== "==" && peek().value !== "!=")) return first;
    const ops: string[] = [];
    const terms: EvalNode[] = [first];
    while (peek().kind === "op" && (peek().value === "==" || peek().value === "!=")) {
      ops.push(consume().value);
      countNode();
      terms.push(parseRelational());
    }
    return (p) => {
      let acc = terms[0](p);
      for (let i = 0; i < ops.length; i += 1) {
        const rhs = terms[i + 1](p);
        acc = ops[i] === "==" ? (acc === rhs ? 1 : 0) : acc !== rhs ? 1 : 0;
      }
      return acc;
    };
  }

  function parseRelational(): EvalNode {
    const first = parseAdditive();
    const isRel = () =>
      peek().kind === "op" &&
      (peek().value === "<" ||
        peek().value === "<=" ||
        peek().value === ">" ||
        peek().value === ">=");
    if (!isRel()) return first;
    const ops: string[] = [];
    const terms: EvalNode[] = [first];
    while (isRel()) {
      ops.push(consume().value);
      countNode();
      terms.push(parseAdditive());
    }
    return (p) => {
      let acc = terms[0](p);
      for (let i = 0; i < ops.length; i += 1) {
        const rhs = terms[i + 1](p);
        const op = ops[i];
        if (op === "<") acc = acc < rhs ? 1 : 0;
        else if (op === "<=") acc = acc <= rhs ? 1 : 0;
        else if (op === ">") acc = acc > rhs ? 1 : 0;
        else acc = acc >= rhs ? 1 : 0;
      }
      return acc;
    };
  }

  function parseAdditive(): EvalNode {
    const first = parseMultiplicative();
    if (peek().kind !== "op" || (peek().value !== "+" && peek().value !== "-")) return first;
    const ops: string[] = [];
    const terms: EvalNode[] = [first];
    while (peek().kind === "op" && (peek().value === "+" || peek().value === "-")) {
      ops.push(consume().value);
      countNode();
      terms.push(parseMultiplicative());
    }
    return (p) => {
      let acc = terms[0](p);
      for (let i = 0; i < ops.length; i += 1) {
        const rhs = terms[i + 1](p);
        acc = ops[i] === "+" ? acc + rhs : acc - rhs;
      }
      return acc;
    };
  }

  function parseMultiplicative(): EvalNode {
    const first = parseUnary();
    const isMul = () =>
      peek().kind === "op" &&
      (peek().value === "*" || peek().value === "/" || peek().value === "%");
    if (!isMul()) return first;
    const ops: string[] = [];
    const terms: EvalNode[] = [first];
    while (isMul()) {
      ops.push(consume().value);
      countNode();
      terms.push(parseUnary());
    }
    return (p) => {
      let acc = terms[0](p);
      for (let i = 0; i < ops.length; i += 1) {
        const rhs = terms[i + 1](p);
        const op = ops[i];
        if (op === "*") acc *= rhs;
        else if (op === "/") acc /= rhs;
        else acc %= rhs;
      }
      return acc;
    };
  }

  function parseUnary(): EvalNode {
    if (
      peek().kind === "op" &&
      (peek().value === "+" || peek().value === "-" || peek().value === "!")
    ) {
      const op = consume().value;
      countNode();
      const operand = withDepth(() => parseUnary());
      if (op === "+") return (p) => +operand(p);
      if (op === "-") return (p) => -operand(p);
      return (p) => (operand(p) ? 0 : 1);
    }
    return parsePower();
  }

  function parsePower(): EvalNode {
    const base = parsePrimary();
    if (peek().kind === "op" && peek().value === "**") {
      consume();
      countNode();
      const exp = withDepth(() => parseUnary());
      return (p) => Math.pow(base(p), exp(p));
    }
    return base;
  }

  function buildCall(name: string, args: EvalNode[]): EvalNode {
    switch (name) {
      case "where": {
        const [c, a, b] = args;
        return (p) => (c(p) ? a(p) : b(p));
      }
      case "clip": {
        const [v, lo, hi] = args;
        return (p) => Math.min(Math.max(v(p), lo(p)), hi(p));
      }
      case "log":
        return (p) => Math.log(args[0](p));
      case "exp":
        return (p) => Math.exp(args[0](p));
      case "sqrt":
        return (p) => Math.sqrt(args[0](p));
      case "abs":
        return (p) => Math.abs(args[0](p));
      case "minimum":
        return (p) => Math.min(args[0](p), args[1](p));
      case "maximum":
        return (p) => Math.max(args[0](p), args[1](p));
      case "min":
        return (p) => {
          let best = args[0](p);
          for (let i = 1; i < args.length; i += 1) {
            const val = args[i](p);
            if (Number.isNaN(val) || val < best) best = val;
          }
          return best;
        };
      case "max":
        return (p) => {
          let best = args[0](p);
          for (let i = 1; i < args.length; i += 1) {
            const val = args[i](p);
            if (Number.isNaN(val) || val > best) best = val;
          }
          return best;
        };
      case "sin":
        return (p) => Math.sin(args[0](p));
      case "cos":
        return (p) => Math.cos(args[0](p));
      case "tan":
        return (p) => Math.tan(args[0](p));
      case "pow":
        return (p) => Math.pow(args[0](p), args[1](p));
      case "floor":
        return (p) => Math.floor(args[0](p));
      case "ceil":
        return (p) => Math.ceil(args[0](p));
      case "round":
        return (p) => Math.round(args[0](p));
      default:
        throw new Error(`Unsupported function "${name}".`);
    }
  }

  function parsePrimary(): EvalNode {
    const token = peek();
    if (token.kind === "number") {
      consume();
      const num = Number(token.value);
      if (!Number.isFinite(num)) {
        throw new Error(`Invalid numeric literal "${token.value}".`);
      }
      return () => num;
    }

    if (token.kind === "lparen") {
      consume();
      const inner = withDepth(() => parseOr());
      if (peek().kind !== "rparen") {
        throw new Error(`Invalid expression: expected ')' at position ${peek().pos}.`);
      }
      consume();
      return inner;
    }

    if (token.kind === "ident") {
      consume();
      const name = token.value;
      const fnSpec = Object.prototype.hasOwnProperty.call(ALLOWED_FUNCTIONS, name)
        ? ALLOWED_FUNCTIONS[name]
        : undefined;
      if (fnSpec) {
        countNode();
        if (peek().kind !== "lparen") {
          throw new Error(`Function "${name}" must be called with parentheses.`);
        }
        consume();
        const args: EvalNode[] = [];
        if (peek().kind !== "rparen") {
          while (true) {
            args.push(withDepth(() => parseOr()));
            if (peek().kind === "comma") {
              consume();
              continue;
            }
            break;
          }
        }
        if (peek().kind !== "rparen") {
          throw new Error(`Invalid expression: expected ')' after arguments to "${name}".`);
        }
        consume();
        if (args.length < fnSpec.minArgs || args.length > fnSpec.maxArgs) {
          throw new Error(
            `Function "${name}" expects ${fnSpec.minArgs === fnSpec.maxArgs ? fnSpec.minArgs : `${fnSpec.minArgs}–${fnSpec.maxArgs}`} argument(s), got ${args.length}.`,
          );
        }
        return buildCall(name, args);
      }

      const bandMatch = BAND_REF_RE.exec(name);
      if (bandMatch) {
        const rasterKey = bandMatch[1];
        const bandIndex = bandMatch[2] ? Number(bandMatch[2]) : 1;
        const bands = rasters[rasterKey];
        if (!bands) {
          throw new Error(
            `Raster ${rasterKey} is referenced in the expression but was not provided. ` +
              `Provide raster ${rasterKey} or use only provided inputs.`,
          );
        }
        if (!Number.isInteger(bandIndex) || bandIndex < 1 || bandIndex > bands.length) {
          throw new Error(
            `Band ${name} is out of range (raster ${rasterKey} has ${bands.length} band${bands.length === 1 ? "" : "s"}).`,
          );
        }
        const key = `${rasterKey}:${bandIndex}`;
        if (!referencedMap.has(key)) {
          referencedMap.set(key, { raster: rasterKey, band: bandIndex, raw: name });
        }
        const arr = bands[bandIndex - 1];
        return (p) => arr[p];
      }

      throw new Error(
        `Expression contains unsupported identifiers ("${name}"). Only raster bands (A, B, C, A1, B2 ...) and the math helpers ` +
          "(where, clip, log, exp, sqrt, abs, minimum, maximum, min, max, sin, cos, tan, pow, floor, ceil, round) are allowed.",
      );
    }

    throw new Error(
      `Invalid expression: unexpected token "${token.value || "end of input"}" at position ${token.pos}.`,
    );
  }

  const root = parseOr();
  if (peek().kind !== "eof") {
    throw new Error(
      `Invalid expression: unexpected token "${peek().value}" at position ${peek().pos}.`,
    );
  }
  return {
    referencedBands: Array.from(referencedMap.values()),
    evaluate: root,
  };
}
