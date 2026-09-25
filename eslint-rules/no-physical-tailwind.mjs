// Flags physical Tailwind direction utilities (`ml-*`, `pr-*`, `left-*`,
// `text-right`, ...) in class strings. The UI mirrors for right-to-left
// locales, so components use the logical forms (`ms-*`/`me-*`, `ps-*`/`pe-*`,
// `start-*`/`end-*`, `text-start`/`text-end`) that flip with the document
// direction. See docs/i18n.md, "Right-to-left languages".
//
// Checked strings: string literals and template-literal text inside a
// `className` JSX attribute, and inside calls to the class helpers `cn`,
// `clsx`, `cva` and `twMerge` anywhere in the file.
//
// Allowed on purpose (they do not change meaning under RTL):
// - symmetric centering, `left-1/2` / `left-[50%]` (with a translate);
// - a matching pair of opposite sides in the same string, such as
//   `left-0 right-0` or `pl-2 pr-2`.
// Map-anchored overlays and other deliberately physical placements should
// carry an `eslint-disable-next-line local/no-physical-tailwind` comment that
// says why.

const CLASS_HELPERS = new Set(["cn", "clsx", "cva", "twMerge"]);

// prefix -> [opposite prefix, logical replacement]
const PHYSICAL = {
  ml: ["mr", "ms"],
  mr: ["ml", "me"],
  pl: ["pr", "ps"],
  pr: ["pl", "pe"],
  left: ["right", "start"],
  right: ["left", "end"],
};
const TEXT_ALIGN = { "text-left": "text-start", "text-right": "text-end" };
const CENTERING = new Set(["left-1/2", "right-1/2", "left-[50%]", "right-[50%]"]);
const PHYSICAL_RE = /^(ml|mr|pl|pr|left|right)-(.+)$/;

/**
 * Reduces a Tailwind token to its utility, dropping variants (`md:`,
 * `hover:`, `rtl:`), the important marker and a negative sign.
 *
 * @param {string} token A single whitespace-delimited class token.
 * @returns {{ utility: string, variants: string }} The bare utility and the
 *   variant prefix it was written under.
 */
function splitToken(token) {
  // Variants are colon-separated, but arbitrary values may contain colons
  // (`[mask:url(...)]`), so only split outside square brackets.
  let depth = 0;
  let last = -1;
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
    else if (ch === ":" && depth === 0) last = i;
  }
  const variants = last >= 0 ? token.slice(0, last + 1) : "";
  let utility = last >= 0 ? token.slice(last + 1) : token;
  utility = utility.replace(/^!/, "").replace(/!$/, "").replace(/^-/, "");
  return { utility, variants };
}

/**
 * Finds the physical direction utilities in one class string.
 *
 * @param {string} text The class string.
 * @returns {Array<{ token: string, suggestion: string }>} One entry per
 *   offending token, with the logical utility to use instead.
 */
export function findPhysicalClasses(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const parsed = tokens.map((token) => ({ token, ...splitToken(token) }));
  const present = new Set(parsed.map((p) => p.variants + p.utility));
  const found = [];
  for (const { token, utility, variants } of parsed) {
    if (TEXT_ALIGN[utility]) {
      found.push({ token, suggestion: TEXT_ALIGN[utility] });
      continue;
    }
    const match = PHYSICAL_RE.exec(utility);
    if (!match) continue;
    if (CENTERING.has(utility)) continue;
    const [, prefix, value] = match;
    const [opposite, logical] = PHYSICAL[prefix];
    if (present.has(`${variants}${opposite}-${value}`)) continue;
    found.push({ token, suggestion: `${logical}-${value}` });
  }
  return found;
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Use logical Tailwind direction utilities (ms-/me-/ps-/pe-/start-/end-/text-start/text-end) so layouts mirror for right-to-left locales",
    },
    schema: [],
    messages: {
      physical:
        "Physical Tailwind class `{{token}}` does not mirror in right-to-left locales; use `{{suggestion}}` (see docs/i18n.md).",
    },
  },
  create(context) {
    const seen = new WeakSet();

    function checkText(node, text) {
      for (const { token, suggestion } of findPhysicalClasses(text)) {
        context.report({ node, messageId: "physical", data: { token, suggestion } });
      }
    }

    // Walk an expression and check every string piece in it. Only strings
    // that can end up in a class list are reached: literals, template
    // text, and the branches of conditionals, logical operators, arrays,
    // object keys (clsx's `{ "ml-2": cond }`) and nested helper calls.
    function visit(node) {
      if (!node || seen.has(node)) return;
      seen.add(node);
      switch (node.type) {
        case "Literal":
          if (typeof node.value === "string") checkText(node, node.value);
          break;
        case "TemplateLiteral":
          for (const quasi of node.quasis) checkText(quasi, quasi.value.cooked ?? "");
          for (const expr of node.expressions) visit(expr);
          break;
        case "JSXExpressionContainer":
          visit(node.expression);
          break;
        case "ConditionalExpression":
          visit(node.consequent);
          visit(node.alternate);
          break;
        case "LogicalExpression":
          visit(node.left);
          visit(node.right);
          break;
        case "BinaryExpression":
          if (node.operator === "+") {
            visit(node.left);
            visit(node.right);
          }
          break;
        case "ArrayExpression":
          for (const el of node.elements) visit(el);
          break;
        case "ObjectExpression":
          for (const prop of node.properties) {
            if (prop.type !== "Property") continue;
            if (prop.key.type === "Literal") visit(prop.key);
            // cva's `variants` config nests class strings as values.
            visit(prop.value);
          }
          break;
        case "CallExpression":
          for (const arg of node.arguments) visit(arg);
          break;
        case "TSAsExpression":
        case "TSSatisfiesExpression":
          visit(node.expression);
          break;
        default:
          break;
      }
    }

    return {
      JSXAttribute(node) {
        if (node.name.type === "JSXIdentifier" && node.name.name === "className") {
          visit(node.value);
        }
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier" && CLASS_HELPERS.has(node.callee.name)) {
          visit(node);
        }
      },
    };
  },
};

export default {
  meta: { name: "geolibre-local" },
  rules: { "no-physical-tailwind": rule },
};
