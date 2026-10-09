/**
 * Rulesets for the Object-Based Analysis workbench: fuzzy class descriptions
 * and a domain-scoped, iterative process tree, as in eCognition rulesets.
 *
 * A process acts on a domain (the objects of some current classes that meet
 * some conditions) and either assigns a class, classifies the domain by fuzzy
 * class descriptions, or repeats child processes until nothing changes.
 * Conditions read the objects' features and, recomputed before each process,
 * `nb_border_<class>`: the share of an object's border shared with neighbors
 * currently of that class. That is what lets a loop grow a class outwards.
 */
import { classFieldSlug, type ObiaAdjacency } from "./obia-hierarchy";
import type { ObiaFeatureTable, ObiaRuleOp } from "./obia";

/** A feature test. */
export interface ObiaCondition {
  field: string;
  op: ObiaRuleOp;
  value: number;
}

/**
 * Which objects a process acts on: those whose current class is one of
 * `classes` (`""` for unclassified; omitted for any) and that meet every
 * condition.
 */
export interface ObiaDomain {
  classes?: string[];
  conditions?: ObiaCondition[];
}

/** A fuzzy membership function over one feature, from 0 to 1. */
export type ObiaMembership =
  | { field: string; type: "larger"; from: number; to: number }
  | { field: string; type: "smaller"; from: number; to: number }
  | { field: string; type: "about"; center: number; width: number };

/** A fuzzy class description: membership functions combined by an operator. */
export interface ObiaFuzzyClass {
  className: string;
  combine?: "and" | "or" | "mean";
  memberships: ObiaMembership[];
}

/** One process of a ruleset. */
export type ObiaProcess =
  | { kind: "assign"; name?: string; domain?: ObiaDomain; className: string }
  | {
      kind: "fuzzy";
      name?: string;
      domain?: ObiaDomain;
      classes: ObiaFuzzyClass[];
      /**
       * Below this best membership an object is left as it is (0.1 when
       * omitted); an object whose best membership is 0 is always left.
       * Ties go to the class listed first.
       */
      minMembership?: number;
    }
  | { kind: "loop"; name?: string; processes: ObiaProcess[]; maxIterations?: number };

/** A ruleset: processes run in order. */
export interface ObiaRuleset {
  processes: ObiaProcess[];
}

/** What one process did, for the run log. */
export interface ObiaProcessLog {
  /** Position in the tree, e.g. "2.1". */
  path: string;
  name: string;
  /** Objects whose class it changed. */
  changed: number;
  /** For a loop, how many times it ran its processes. */
  iterations?: number;
}

const OPS = new Set([">", ">=", "<", "<=", "==", "!="]);

/**
 * Process runs a ruleset may make in all: nested loops multiply, and a ruleset
 * that never settles must not freeze the app.
 */
export const OBIA_RULESET_MAX_STEPS = 10_000;

/** How deeply loops may nest. */
export const OBIA_RULESET_MAX_DEPTH = 8;

/** The longest ruleset text the workbench reads or saves. */
export const OBIA_RULESET_MAX_CHARS = 200_000;

/** Why a ruleset run stopped, as a translatable code. */
export class ObiaRulesetError extends Error {
  readonly code: "too-long";

  constructor(code: "too-long") {
    super(
      `The ruleset ran more than ${OBIA_RULESET_MAX_STEPS.toLocaleString("en-US")} processes without settling.`,
    );
    this.name = "ObiaRulesetError";
    this.code = code;
  }
}

/** The class names a ruleset assigns (assign and fuzzy classes, in loops too). */
export function rulesetClassNames(value: unknown): string[] {
  const names: string[] = [];
  const add = (name: unknown) => {
    if (typeof name === "string" && name && !names.includes(name)) names.push(name);
  };
  // Bounded like validation, so deeply nested input can't overflow the stack.
  const walk = (list: unknown, depth: number) => {
    if (!Array.isArray(list) || depth > OBIA_RULESET_MAX_DEPTH) return;
    for (const item of list) {
      const p = item as Record<string, unknown> | null;
      if (!p || typeof p !== "object") continue;
      add(p.className);
      if (Array.isArray(p.classes)) {
        for (const c of p.classes) add((c as Record<string, unknown> | null)?.className);
      }
      walk(p.processes, depth + 1);
    }
  };
  walk((value as Record<string, unknown> | null)?.processes, 0);
  return names;
}

/**
 * The classes a ruleset's `nb_border_<slug>` fields can name, in slug order:
 * the given classes, then ones only the ruleset assigns.
 */
function rulesetClassOrder(classes: readonly string[], ruleset: unknown): string[] {
  return [...classes, ...rulesetClassNames(ruleset).filter((name) => !classes.includes(name))];
}

/**
 * The `nb_border_<slug>` slugs of class names, slug to name, made the same
 * way everywhere (in order, so colliding names get the same suffixes).
 */
export function classSlugs(names: readonly string[]): Map<string, string> {
  const taken = new Set<string>();
  return new Map(names.map((name) => [classFieldSlug(name, taken), name] as const));
}

/**
 * Check a parsed ruleset and return it typed, or the first problem found.
 *
 * @param value Parsed JSON.
 * @param fields The feature fields conditions and memberships may read.
 * @param classes The workbench's class names; with the classes the ruleset
 *   assigns, they make the `nb_border_<class>` fields it may read.
 */
export function validateRuleset(
  value: unknown,
  fields: readonly string[],
  classes: readonly string[] = [],
): { ruleset: ObiaRuleset } | { error: string } {
  const known = new Set(fields);
  const borders = classSlugs(rulesetClassOrder(classes, value));
  const isField = (field: unknown) =>
    typeof field === "string" &&
    (known.has(field) ||
      (field.startsWith("nb_border_") && borders.has(field.slice("nb_border_".length))));
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const checkDomain = (domain: unknown, at: string): string | null => {
    if (domain == null) return null;
    if (typeof domain !== "object") return `${at}: domain must be an object`;
    const d = domain as Record<string, unknown>;
    if (
      d.classes != null &&
      (!Array.isArray(d.classes) || !d.classes.every((c) => typeof c === "string"))
    ) {
      return `${at}: domain.classes must be a list of class names`;
    }
    if (d.conditions != null) {
      if (!Array.isArray(d.conditions)) return `${at}: domain.conditions must be a list`;
      for (const [i, c] of d.conditions.entries()) {
        const cond = c as Record<string, unknown>;
        if (!cond || !isField(cond.field))
          return `${at}: condition ${i + 1} reads an unknown field "${String(cond?.field)}"`;
        if (!OPS.has(String(cond.op)))
          return `${at}: condition ${i + 1} has an unknown operator "${String(cond.op)}"`;
        if (!num(cond.value)) return `${at}: condition ${i + 1} needs a numeric value`;
      }
    }
    return null;
  };
  const checkProcesses = (list: unknown, prefix: string, depth: number): string | null => {
    if (!Array.isArray(list) || !list.length)
      return `${prefix || "ruleset"}: needs at least one process`;
    if (depth > OBIA_RULESET_MAX_DEPTH) return `${prefix}: loops are nested too deeply`;
    for (const [i, item] of list.entries()) {
      const at = prefix ? `${prefix}.${i + 1}` : `process ${i + 1}`;
      const p = item as Record<string, unknown>;
      if (!p || typeof p !== "object") return `${at}: must be an object`;
      if (p.name != null && typeof p.name !== "string") return `${at}: name must be text`;
      if (p.kind === "assign") {
        if (typeof p.className !== "string" || !p.className.trim())
          return `${at}: assign needs a className`;
        const err = checkDomain(p.domain, at);
        if (err) return err;
      } else if (p.kind === "fuzzy") {
        const err = checkDomain(p.domain, at);
        if (err) return err;
        if (
          p.minMembership != null &&
          !(
            num(p.minMembership) &&
            (p.minMembership as number) >= 0 &&
            (p.minMembership as number) <= 1
          )
        ) {
          return `${at}: minMembership must be between 0 and 1`;
        }
        if (!Array.isArray(p.classes) || !p.classes.length)
          return `${at}: fuzzy needs class descriptions`;
        for (const [j, c] of p.classes.entries()) {
          const cls = c as Record<string, unknown>;
          if (!cls || typeof cls.className !== "string" || !cls.className.trim())
            return `${at}: class ${j + 1} needs a className`;
          if (cls.combine != null && !["and", "or", "mean"].includes(String(cls.combine))) {
            return `${at}: class ${j + 1} combine must be and, or or mean`;
          }
          if (!Array.isArray(cls.memberships) || !cls.memberships.length) {
            return `${at}: class ${j + 1} needs memberships`;
          }
          for (const [k, m] of cls.memberships.entries()) {
            const mem = m as Record<string, unknown>;
            const where = `${at}: class ${j + 1} membership ${k + 1}`;
            if (!mem || !isField(mem.field))
              return `${where} reads an unknown field "${String(mem?.field)}"`;
            if (mem.type === "larger" || mem.type === "smaller") {
              if (!num(mem.from) || !num(mem.to) || (mem.from as number) >= (mem.to as number)) {
                return `${where} needs numbers from < to`;
              }
            } else if (mem.type === "about") {
              if (!num(mem.center) || !num(mem.width) || (mem.width as number) <= 0) {
                return `${where} needs a center and a positive width`;
              }
            } else {
              return `${where} has an unknown type "${String(mem.type)}"`;
            }
          }
        }
      } else if (p.kind === "loop") {
        if (
          p.maxIterations != null &&
          !(
            Number.isInteger(p.maxIterations) &&
            (p.maxIterations as number) >= 1 &&
            (p.maxIterations as number) <= 1000
          )
        ) {
          return `${at}: maxIterations must be a whole number from 1 to 1000`;
        }
        const err = checkProcesses(p.processes, at, depth + 1);
        if (err) return err;
      } else {
        return `${at}: unknown kind "${String(p.kind)}" (assign, fuzzy or loop)`;
      }
    }
    return null;
  };
  const rs = value as Record<string, unknown>;
  if (!rs || typeof rs !== "object") return { error: "The ruleset must be a JSON object" };
  const err = checkProcesses(rs.processes, "", 0);
  return err ? { error: err } : { ruleset: value as ObiaRuleset };
}

/** A membership value in [0, 1]; null when the feature has no value. */
export function membershipValue(m: ObiaMembership, x: number | null | undefined): number | null {
  if (x == null || !Number.isFinite(x)) return null;
  switch (m.type) {
    case "larger":
      return x <= m.from ? 0 : x >= m.to ? 1 : (x - m.from) / (m.to - m.from);
    case "smaller":
      return x <= m.from ? 1 : x >= m.to ? 0 : (m.to - x) / (m.to - m.from);
    case "about": {
      const d = Math.abs(x - m.center);
      return d >= m.width ? 0 : 1 - d / m.width;
    }
  }
}

/** A fuzzy class's membership for one object (a missing feature counts as 0). */
export function classMembership(
  cls: ObiaFuzzyClass,
  value: (field: string) => number | null | undefined,
): number {
  const values = cls.memberships.map((m) => membershipValue(m, value(m.field)) ?? 0);
  if (!values.length) return 0;
  switch (cls.combine ?? "and") {
    case "and":
      return Math.min(...values);
    case "or":
      return Math.max(...values);
    case "mean":
      return values.reduce((a, b) => a + b, 0) / values.length;
  }
}

const compare = (x: number, op: ObiaRuleOp, y: number) =>
  op === ">"
    ? x > y
    : op === ">="
      ? x >= y
      : op === "<"
        ? x < y
        : op === "<="
          ? x <= y
          : op === "=="
            ? x === y
            : x !== y;

/**
 * Run a ruleset over a level's objects.
 *
 * @param table The objects' features.
 * @param adjacency Shared border between objects, for `nb_border_<class>`.
 * @param classes Class names, for the `nb_border_<class>` field names.
 * @param ruleset The processes.
 * @param initial Classes the objects start with (missing = unclassified).
 * @returns Each object's class (unclassified objects are left out) and what
 *   each process did.
 */
export function runRuleset(
  table: ObiaFeatureTable,
  adjacency: ObiaAdjacency,
  classes: readonly string[],
  ruleset: ObiaRuleset,
  initial: ReadonlyMap<number, string> = new Map(),
): { predictions: Map<number, string>; log: ObiaProcessLog[] } {
  const current = new Map<number, string>();
  for (const id of table.rows.keys()) {
    const name = initial.get(id);
    if (name) current.set(id, name);
  }
  const nameOfSlug = classSlugs(rulesetClassOrder(classes, ruleset));
  // Border shares by class from `current` as each process starts, computed
  // only when a process reads an nb_border_ field.
  let border: Map<number, Map<string, number>> | null = null;
  const borderShares = () => {
    const border = new Map<number, Map<string, number>>();
    for (const [id, neighbors] of adjacency) {
      let total = 0;
      const byClass = new Map<string, number>();
      for (const [other, edges] of neighbors) {
        total += edges;
        const name = current.get(other);
        if (name) byClass.set(name, (byClass.get(name) ?? 0) + edges);
      }
      const shares = new Map<string, number>();
      for (const [name, edges] of byClass) shares.set(name, total ? edges / total : 0);
      border.set(id, shares);
    }
    return border;
  };
  const valueOf =
    (id: number) =>
    (field: string): number | null | undefined => {
      if (field.startsWith("nb_border_")) {
        const name = nameOfSlug.get(field.slice("nb_border_".length));
        if (name == null) return 0;
        border ??= borderShares();
        return border.get(id)?.get(name) ?? 0;
      }
      return table.rows.get(id)?.[field];
    };
  const inDomain = (id: number, domain: ObiaDomain | undefined) => {
    if (!domain) return true;
    if (domain.classes) {
      const name = current.get(id) ?? "";
      if (!domain.classes.includes(name)) return false;
    }
    const value = valueOf(id);
    return (domain.conditions ?? []).every((c) => {
      const x = value(c.field);
      return x != null && Number.isFinite(x) && compare(x, c.op, c.value);
    });
  };

  // One entry per process, in tree order; a loop's processes add up their
  // changes over its iterations.
  const log: ObiaProcessLog[] = [];
  const entries = new Map<string, ObiaProcessLog>();
  const entryFor = (path: string, name: string) => {
    let entry = entries.get(path);
    if (!entry) {
      entry = { path, name, changed: 0 };
      entries.set(path, entry);
      log.push(entry);
    }
    return entry;
  };
  let steps = 0;
  const runList = (processes: ObiaProcess[], prefix: string): number => {
    let changedTotal = 0;
    processes.forEach((process, index) => {
      const path = prefix ? `${prefix}.${index + 1}` : String(index + 1);
      const name = process.name ?? process.kind;
      if (process.kind === "loop") {
        const max = process.maxIterations ?? 100;
        let iterations = 0;
        let changed = 0;
        const entry = entryFor(path, name);
        while (iterations < max) {
          iterations += 1;
          const step = runList(process.processes, path);
          changed += step;
          if (!step) break;
        }
        entry.changed += changed;
        entry.iterations = (entry.iterations ?? 0) + iterations;
        changedTotal += changed;
        return;
      }
      steps += 1;
      if (steps > OBIA_RULESET_MAX_STEPS) throw new ObiaRulesetError("too-long");
      border = null;
      // Decide for every object first, then apply, so a process sees the
      // classes as they were when it started.
      const updates: [number, string][] = [];
      for (const id of table.rows.keys()) {
        if (!inDomain(id, process.domain)) continue;
        if (process.kind === "assign") {
          updates.push([id, process.className]);
        } else {
          const value = valueOf(id);
          let best: string | null = null;
          let bestValue = -1;
          for (const cls of process.classes) {
            const m = classMembership(cls, value);
            if (m > bestValue) {
              best = cls.className;
              bestValue = m;
            }
          }
          if (best != null && bestValue >= (process.minMembership ?? 0.1) && bestValue > 0) {
            updates.push([id, best]);
          }
        }
      }
      let changed = 0;
      for (const [id, name] of updates) {
        if (current.get(id) !== name) {
          current.set(id, name);
          changed += 1;
        }
      }
      entryFor(path, name).changed += changed;
      changedTotal += changed;
    });
    return changedTotal;
  };
  runList(ruleset.processes, "");
  return { predictions: current, log };
}
