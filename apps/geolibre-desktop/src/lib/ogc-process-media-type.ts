/** Compare HTTP media types without folding case-sensitive parameter values. */
export function parseProcessMediaType(
  value: string,
): { base: string; key: string; parameters: ReadonlyMap<string, string> } | undefined {
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) return undefined;
  const parts: string[] = [];
  let start = 0,
    quoted = false,
    escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (character === ";" && !quoted) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped) return undefined;
  parts.push(value.slice(start));
  const base = parts.shift()!.trim().toLowerCase();
  if (!/^[!#$%&'*+.^_`|~\w-]+\/[!#$%&'*+.^_`|~\w-]+$/.test(base)) return undefined;
  const parameters = new Map<string, string>();
  for (const part of parts) {
    const match =
      /^\s*([!#$%&'*+.^_`|~\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([!#$%&'*+.^_`|~\w-]+))\s*$/.exec(
        part,
      );
    if (!match) return undefined;
    const name = match[1].toLowerCase();
    if (parameters.has(name)) return undefined;
    const parameter = (match[2] ?? match[3]).replace(/\\(.)/g, "$1");
    parameters.set(name, name === "charset" ? parameter.toLowerCase() : parameter);
  }
  return {
    base,
    parameters,
    key: JSON.stringify([
      base,
      ...[...parameters].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ]),
  };
}
