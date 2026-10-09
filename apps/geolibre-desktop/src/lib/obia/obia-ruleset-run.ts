import {
  classFieldSlug,
  decodeLabelGrid,
  objectAdjacency,
  runRuleset,
  validateRuleset,
  type ObiaClassification,
  type ObiaFeatureTable,
  type ObiaProcessLog,
  type ObiaRuleset,
  type ObiaRunOptions,
} from "@geolibre/processing";
import { ensureObiaLabels } from "./obia-persistence";
import { useObiaSession } from "./obia-session";

/**
 * Parse and check ruleset text against the features it may read.
 *
 * @returns The ruleset, or the problem (a JSON syntax error or the first
 *   invalid part).
 */
export function parseRuleset(
  text: string,
  fields: readonly string[],
): { ruleset: ObiaRuleset } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Not valid JSON" };
  }
  return validateRuleset(value, fields);
}

/**
 * An example ruleset for the current classes and features: fuzzy classes from
 * the first two classes, then a loop that grows the first class into
 * unclassified neighbors, then a default.
 */
export function exampleRuleset(classes: readonly string[], fields: readonly string[]): string {
  const [first = "vegetation", second = "built"] = classes;
  const feature = fields.includes("ndvi")
    ? "ndvi"
    : (fields.find((f) => f.startsWith("mean_b")) ?? "ndvi");
  const slug = classFieldSlug(first, new Set());
  const ruleset: ObiaRuleset = {
    processes: [
      {
        kind: "fuzzy",
        name: "spectral classes",
        minMembership: 0.5,
        classes: [
          {
            className: first,
            memberships: [{ field: feature, type: "larger", from: 0.1, to: 0.4 }],
          },
          {
            className: second,
            memberships: [{ field: feature, type: "smaller", from: -0.1, to: 0.1 }],
          },
        ],
      },
      {
        kind: "loop",
        name: `grow ${first}`,
        maxIterations: 20,
        processes: [
          {
            kind: "assign",
            domain: {
              classes: [""],
              conditions: [
                { field: `nb_border_${slug}`, op: ">=", value: 0.5 },
                { field: feature, op: ">", value: 0 },
              ],
            },
            className: first,
          },
        ],
      },
    ],
  };
  return JSON.stringify(ruleset, null, 2);
}

/**
 * Run the ruleset method on the current level: the processes in order, with
 * objects left unclassified given the default class.
 *
 * @param table Features of every object of the level (see tableForAllObjects).
 * @param ruleset A validated ruleset.
 * @param options Default class, and whether to start from the current
 *   classification.
 * @param run Cancellation and progress.
 */
export async function runObiaRuleset(
  table: ObiaFeatureTable,
  ruleset: ObiaRuleset,
  options: { defaultClass: string; fromCurrent: boolean },
  run: ObiaRunOptions = {},
): Promise<{ result: ObiaClassification; log: ObiaProcessLog[] }> {
  const { classes, classification } = useObiaSession.getState();
  run.onStep?.("ruleset");
  const grid = await decodeLabelGrid(await ensureObiaLabels(run));
  const { predictions, log } = runRuleset(
    table,
    objectAdjacency(grid),
    classes.map((item) => item.name),
    ruleset,
    options.fromCurrent && classification ? classification.predictions : new Map(),
  );
  for (const id of table.rows.keys()) {
    if (!predictions.has(id)) predictions.set(id, options.defaultClass);
  }
  return {
    result: {
      predictions,
      fields: [],
      imputed: {},
      trainingCount: 0,
      call: { tool: "obia/ruleset", args: [JSON.stringify(ruleset)] },
    },
    log,
  };
}
