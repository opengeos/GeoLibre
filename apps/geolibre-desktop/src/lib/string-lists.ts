// Shared helpers for the trimmed, deduplicated string lists used by the
// plugin-source settings (directories and manifest URLs). normalizeStringList
// intentionally mirrors uniqueStrings in packages/core/src/project.ts, which
// stays private to core's project parsing; update both if the rules change.

export function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalizedValue = value.trim();
    if (!normalizedValue || seen.has(normalizedValue)) continue;
    seen.add(normalizedValue);
    normalized.push(normalizedValue);
  }
  return normalized;
}

export function mergeStringLists(...lists: string[][]): string[] {
  return normalizeStringList(lists.flat());
}
