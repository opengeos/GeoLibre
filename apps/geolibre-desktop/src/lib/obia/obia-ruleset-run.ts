import {
  classSlugs,
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
  classes: readonly string[] = [],
): { ruleset: ObiaRuleset } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Not valid JSON" };
  }
  return validateRuleset(value, fields, classes);
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
  // The same slugs the engine makes for these classes.
  const slug = [...classSlugs(classes.length ? classes : [first, second])].find(
    ([, name]) => name === first,
  )?.[0];
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
 * The fields a ruleset reads (conditions and memberships, in loops too), or
 * none when the text is not a ruleset.
 */
export function rulesetFields(text: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const fields: string[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const p = item as Record<string, unknown> | null;
      if (!p || typeof p !== "object") continue;
      const conditions = (p.domain as Record<string, unknown> | undefined)?.conditions;
      if (Array.isArray(conditions)) {
        for (const c of conditions) fields.push(String((c as Record<string, unknown>)?.field));
      }
      if (Array.isArray(p.classes)) {
        for (const c of p.classes) {
          const memberships = (c as Record<string, unknown> | null)?.memberships;
          if (Array.isArray(memberships)) {
            for (const m of memberships) fields.push(String((m as Record<string, unknown>)?.field));
          }
        }
      }
      walk(p.processes);
    }
  };
  walk((value as Record<string, unknown> | null)?.processes);
  return fields;
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
    // Objects holding the default class start unclassified, so a domain of
    // unclassified objects ("") still finds them.
    options.fromCurrent && classification
      ? new Map(
          [...classification.predictions].filter(([, name]) => name !== options.defaultClass),
        )
      : new Map(),
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
