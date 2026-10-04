// Keeps app, plugin and core code from branching on which renderer is live.
//
// Every map engine publishes a `MapEngineCapabilities` object (see
// packages/map/src/map-engine.ts), and UI gates on those flags, never on the
// engine's name: a feature disabled because "the engine is Cesium" gets it
// wrong in both directions — it hides what that engine does natively, and it
// silently stops describing reality the moment another engine appears. The
// desktop app reads them through `useMapCapabilities` (React) or
// `rendererCapabilities` (anywhere else).
//
// This rule reports a renderer-kind expression compared against a renderer
// name literal (`"maplibre"`, `"mapbox"`, `"cesium"`, `"arcgis"`):
//   primaryRenderer === "cesium"        s.primaryRenderer !== "maplibre"
//   engine?.kind === "mapbox"           app.getMapRenderer?.() === "arcgis"
//   switch (renderer) { case "arcgis": }
//   ["mapbox", "arcgis"].includes(renderer)
// A renderer-kind expression is an identifier, property or called function
// whose name ends in `Renderer`/`renderer` (`primaryRenderer`, `renderer`,
// `getMapRenderer()`), a `viewKind`, or the `kind` of something named
// `…engine`/`…Engine`.
//
// Some checks are legitimately about the kind itself: validating or persisting
// a renderer name, the renderer picker, telemetry, and dispatching to an
// engine-specific adapter or handle (`getMapboxMap()`, the ArcGIS SDK bridge)
// that no capability can stand in for. Mark those with
// `// eslint-disable-next-line local/no-renderer-kind-checks -- <reason>`.
// packages/map is where the engines live, so the rule does not apply there.

/** The renderer names a kind is compared against. */
const RENDERER_NAMES = new Set(["maplibre", "mapbox", "cesium", "arcgis"]);

const RENDERER_NAME_PATTERN = /(^r|R)enderer$/;
const KIND_NAMES = new Set(["viewKind", "rendererKind"]);
const ENGINE_OBJECT_PATTERN = /(^e|E)ngine$/;

/**
 * Strip wrappers that do not change which value is compared.
 *
 * @param {any} node An ESTree expression.
 * @returns {any} The innermost expression.
 */
function unwrap(node) {
  let current = node;
  while (
    current &&
    (current.type === "ChainExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSTypeAssertion")
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * The name an identifier or a non-computed member access ends in.
 *
 * @param {any} node An ESTree expression.
 * @returns {string | null} The trailing name, or `null` for anything else.
 */
function trailingName(node) {
  const n = unwrap(node);
  if (!n) return null;
  if (n.type === "Identifier") return n.name;
  if (n.type === "MemberExpression" && !n.computed && n.property.type === "Identifier") {
    return n.property.name;
  }
  return null;
}

/**
 * Whether an expression evaluates to a renderer kind, judged by its name.
 *
 * @param {any} node An ESTree expression.
 * @returns {boolean} `true` for a renderer-kind expression.
 */
export function isRendererKindExpression(node) {
  const n = unwrap(node);
  if (!n) return false;
  if (n.type === "CallExpression") {
    const callee = trailingName(n.callee);
    return callee !== null && RENDERER_NAME_PATTERN.test(callee);
  }
  const name = trailingName(n);
  if (name === null) return false;
  if (RENDERER_NAME_PATTERN.test(name) || KIND_NAMES.has(name)) return true;
  if (name === "kind" && n.type === "MemberExpression") {
    const owner = trailingName(n.object);
    return owner !== null && ENGINE_OBJECT_PATTERN.test(owner);
  }
  return false;
}

/**
 * The renderer name a node is a string literal of, if any.
 *
 * @param {any} node An ESTree expression.
 * @returns {string | null} The renderer name, or `null`.
 */
function rendererLiteral(node) {
  const n = unwrap(node);
  if (n?.type === "Literal" && typeof n.value === "string" && RENDERER_NAMES.has(n.value)) {
    return n.value;
  }
  if (n?.type === "TemplateLiteral" && n.expressions.length === 0) {
    const value = n.quasis[0]?.value.cooked;
    if (RENDERER_NAMES.has(value)) return value;
  }
  return null;
}

const EQUALITY = new Set(["===", "!==", "==", "!="]);

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Forbid comparing a renderer kind against a renderer name outside packages/map; gate on MapEngineCapabilities instead",
    },
    schema: [],
    messages: {
      kindCheck:
        'Branching on the renderer name "{{name}}". Gate on a MapEngineCapabilities flag (useMapCapabilities / rendererCapabilities) instead, adding one if none fits; disable this line with a reason only when the check is about the kind itself (see eslint-rules/no-renderer-kind-checks.mjs).',
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (!EQUALITY.has(node.operator)) return;
        const leftName = rendererLiteral(node.left);
        const rightName = rendererLiteral(node.right);
        const name =
          leftName && isRendererKindExpression(node.right)
            ? leftName
            : rightName && isRendererKindExpression(node.left)
              ? rightName
              : null;
        if (name) context.report({ node, messageId: "kindCheck", data: { name } });
      },
      SwitchStatement(node) {
        if (!isRendererKindExpression(node.discriminant)) return;
        for (const switchCase of node.cases) {
          const name = switchCase.test ? rendererLiteral(switchCase.test) : null;
          if (name) context.report({ node: switchCase, messageId: "kindCheck", data: { name } });
        }
      },
      CallExpression(node) {
        // `["mapbox", "arcgis"].includes(renderer)`
        const callee = unwrap(node.callee);
        if (
          callee?.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "includes" ||
          node.arguments.length < 1 ||
          !isRendererKindExpression(node.arguments[0])
        ) {
          return;
        }
        const list = unwrap(callee.object);
        if (list?.type !== "ArrayExpression") return;
        const name = list.elements.map((element) => rendererLiteral(element)).find(Boolean);
        if (name) context.report({ node, messageId: "kindCheck", data: { name } });
      },
    };
  },
};

export default rule;
