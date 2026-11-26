/** Split HTTP Link values without treating quoted or angle-bracket contents as delimiters. */
function splitHeader(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0,
    quoted = false,
    escaped = false,
    target = false;
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
    if (!target && character === '"') quoted = !quoted;
    if (!quoted && character === "<") target = true;
    if (!quoted && character === ">") target = false;
    if (!quoted && !target && character === delimiter) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

/** Return monitor targets advertised by retained synchronous process executions. */
export function ogcProcessMonitorLinks(header: string | null): string[] {
  return splitHeader(header ?? "", ",").flatMap((part) => {
    const [target, ...parameters] = splitHeader(part, ";");
    const href = /^\s*<([^>]*)>\s*$/.exec(target)?.[1];
    if (!href) return [];
    // An anchor changes the resource described by this link. We only consume
    // links whose context is the current execution response.
    if (parameters.some((parameter) => /^\s*anchor\s*=/i.test(parameter))) return [];
    const monitor = parameters.some((parameter) => {
      const match = /^\s*rel\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;]+))\s*$/i.exec(parameter);
      const relations = (match?.[1] ?? match?.[2] ?? "").replace(/\\(.)/g, "$1");
      return relations.split(/\s+/).some((relation) => relation.toLowerCase() === "monitor");
    });
    return monitor ? [href] : [];
  });
}
