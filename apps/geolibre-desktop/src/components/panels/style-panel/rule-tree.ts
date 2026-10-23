import { styleValue, type GeoLibreLayer, type LayerStyle, type VectorRule } from "@geolibre/core";
import { nextStopColor } from "./classification-helpers";

/** Create a blank rule-based filter rule with a unique id. */
export function createVectorRule(isElse: boolean, color: string): VectorRule {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `rule-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    label: isElse ? "Else" : "",
    filter: "",
    color,
    isElse,
  };
}

/** One row of the rule editor's tree-ordered rule list. */
export interface RuleTreeRow {
  rule: VectorRule;
  depth: number;
  /** True when other rules name this rule as their parent (a group). */
  isGroup: boolean;
}

/**
 * Order the concrete (non-else) rules as a depth-first tree walk following
 * `parentId`, so children render indented under their parent. Rules with a
 * dangling parent id render as roots; rules trapped in a `parentId` cycle are
 * appended at the end so they stay visible and editable.
 */
export function ruleTreeRows(rules: VectorRule[]): RuleTreeRow[] {
  const concrete = rules.filter((rule) => !rule.isElse);
  const byId = new Map(concrete.map((rule) => [rule.id, rule]));
  const childrenOf = new Map<string, VectorRule[]>();
  const roots: VectorRule[] = [];
  for (const rule of concrete) {
    const parent = rule.parentId && rule.parentId !== rule.id ? byId.get(rule.parentId) : undefined;
    if (parent) {
      const siblings = childrenOf.get(parent.id);
      if (siblings) siblings.push(rule);
      else childrenOf.set(parent.id, [rule]);
    } else {
      roots.push(rule);
    }
  }
  const rows: RuleTreeRow[] = [];
  const seen = new Set<string>();
  const visit = (rule: VectorRule, depth: number) => {
    if (seen.has(rule.id)) return;
    seen.add(rule.id);
    const children = childrenOf.get(rule.id) ?? [];
    rows.push({ rule, depth, isGroup: children.length > 0 });
    for (const child of children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  for (const rule of concrete) visit(rule, 0);
  return rows;
}

/**
 * A rule's effective zoom range: its own bounds intersected with every
 * ancestor's, mirroring how `effectiveVectorRules` resolves the tree for
 * rendering. Used to warn when the intersection is empty (the rule never
 * applies), which the rule's own fields alone cannot reveal.
 */
export function effectiveRuleZoomRange(
  rules: VectorRule[],
  rule: VectorRule,
): { minZoom?: number; maxZoom?: number } {
  const byId = new Map(rules.filter((entry) => !entry.isElse).map((entry) => [entry.id, entry]));
  let minZoom = rule.minZoom;
  let maxZoom = rule.maxZoom;
  const seen = new Set([rule.id]);
  let parent = rule.parentId && rule.parentId !== rule.id ? byId.get(rule.parentId) : undefined;
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    if (parent.minZoom !== undefined) {
      minZoom = minZoom === undefined ? parent.minZoom : Math.max(minZoom, parent.minZoom);
    }
    if (parent.maxZoom !== undefined) {
      maxZoom = maxZoom === undefined ? parent.maxZoom : Math.min(maxZoom, parent.maxZoom);
    }
    parent =
      parent.parentId && parent.parentId !== parent.id ? byId.get(parent.parentId) : undefined;
  }
  return { minZoom, maxZoom };
}

/** Ids of a rule and all rules nested (transitively) under it. */
export function ruleSubtreeIds(rules: VectorRule[], id: string): Set<string> {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const rule of rules) {
      if (rule.isElse || ids.has(rule.id)) continue;
      if (rule.parentId && ids.has(rule.parentId)) {
        ids.add(rule.id);
        grew = true;
      }
    }
  }
  return ids;
}

/**
 * The rule-based renderer's rule list and its edit actions for one layer.
 * Rule edits write straight to `style.vectorRules` (no draft), so these are
 * plain render-time closures shared by the rule editor and the Expression
 * Builder's apply path.
 *
 * @param layer - The layer whose rules are edited.
 * @param setLayerStyle - The store's style patch action.
 * @returns The ordered rules plus add/update/remove helpers.
 */
export function createVectorRuleActions(
  layer: GeoLibreLayer,
  setLayerStyle: (id: string, style: Partial<LayerStyle>) => void,
) {
  const { style } = layer;
  // --- Rule-based renderer (immediate writes to style.vectorRules) ---
  const currentRules = styleValue(style, "vectorRules");
  const concreteRules = currentRules.filter((rule) => !rule.isElse);
  const ruleRows = ruleTreeRows(currentRules);
  const elseRule = currentRules.find((rule) => rule.isElse) ?? null;
  const setVectorRules = (rules: VectorRule[]) => setLayerStyle(layer.id, { vectorRules: rules });
  const updateVectorRule = (id: string, patch: Partial<VectorRule>) =>
    setVectorRules(currentRules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  const addChildVectorRule = (parentId: string) => {
    const child = {
      ...createVectorRule(false, nextStopColor(concreteRules.length)),
      parentId,
    };
    // Insert after the parent's whole subtree so the child lands last among
    // its siblings in the tree walk and the else rule stays at the end.
    const subtree = ruleSubtreeIds(currentRules, parentId);
    let insertAt = currentRules.length;
    for (let index = 0; index < currentRules.length; index += 1) {
      if (subtree.has(currentRules[index].id)) insertAt = index + 1;
    }
    const next = [...currentRules];
    next.splice(insertAt, 0, child);
    setVectorRules(next);
  };
  const addVectorRule = () => {
    const next = createVectorRule(false, nextStopColor(concreteRules.length));
    // Keep the catch-all else rule last so it reads as the fallback.
    setVectorRules(elseRule ? [...concreteRules, next, elseRule] : [...concreteRules, next]);
  };
  const removeVectorRule = (id: string) => {
    // Removing a group removes its whole subtree; orphaned children would
    // otherwise silently become top-level rules and change what draws.
    const doomed = ruleSubtreeIds(currentRules, id);
    setVectorRules(currentRules.filter((rule) => !doomed.has(rule.id)));
  };
  const setElseRuleColor = (color: string) => {
    if (elseRule) {
      updateVectorRule(elseRule.id, { color });
      return;
    }
    setVectorRules([...currentRules, createVectorRule(true, color)]);
  };
  const setElseRuleEnabled = (enabled: boolean) => {
    if (elseRule) {
      updateVectorRule(elseRule.id, { enabled: enabled ? undefined : false });
      return;
    }
    // No else record yet (its absence means enabled): unchecking materializes
    // a disabled one, which is what hides features matching no rule.
    if (!enabled) {
      setVectorRules([
        ...currentRules,
        { ...createVectorRule(true, style.fillColor), enabled: false },
      ]);
    }
  };
  return {
    currentRules,
    concreteRules,
    ruleRows,
    elseRule,
    updateVectorRule,
    addChildVectorRule,
    addVectorRule,
    removeVectorRule,
    setElseRuleColor,
    setElseRuleEnabled,
  };
}

export type VectorRuleActions = ReturnType<typeof createVectorRuleActions>;
