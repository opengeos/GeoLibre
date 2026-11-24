import type { AlgorithmParameter } from "@geolibre/processing";

/** Apply a tool parameter's visibility rule, optionally using declared defaults. */
export function isProcessingParameterVisible(
  parameter: AlgorithmParameter,
  values: Record<string, unknown>,
  parameters?: readonly AlgorithmParameter[],
): boolean {
  const rule = parameter.visibleWhen;
  if (!rule) return true;
  const fallback = parameters?.find((entry) => entry.id === rule.param)?.default;
  const current = (values[rule.param] ?? fallback) as string | undefined;
  return "in" in rule
    ? current != null && rule.in.includes(current)
    : current == null || !rule.notIn.includes(current);
}
