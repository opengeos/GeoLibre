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

/** Read the first occurrence of a Link parameter, including an invalid first value. */
function firstParameter(parameters: string[], name: string): string | undefined {
  const parameter = parameters.find(
    (value) => value.trim().split("=", 1)[0].trim().toLowerCase() === name,
  );
  const match =
    parameter && /^\s*[^=]+\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;]+))\s*$/.exec(parameter);
  return match ? (match[1] ?? match[2]).replace(/\\(.)/g, "$1") : undefined;
}

/** Parse links describing this response, preserving reference metadata. */
export function ogcProcessHeaderLinks(
  header: string | null,
): Array<{ href: string; relations: string[]; mediaType?: string; title?: string }> {
  return splitHeader(header ?? "", ",").flatMap((part) => {
    const [target, ...parameters] = splitHeader(part, ";");
    const href = /^\s*<([^>]*)>\s*$/.exec(target)?.[1];
    if (!href) return [];
    // An anchor changes the resource described by this link. We only consume
    // links whose context is the current execution response.
    if (parameters.some((parameter) => /^\s*anchor\s*=/i.test(parameter))) return [];
    const relations = (firstParameter(parameters, "rel") ?? "").split(/\s+/).filter(Boolean);
    const mediaType = firstParameter(parameters, "type");
    const title = firstParameter(parameters, "title");
    return [{ href, relations, ...(mediaType ? { mediaType } : {}), ...(title ? { title } : {}) }];
  });
}

/** Return monitor targets advertised by retained synchronous process executions. */
export function ogcProcessMonitorLinks(header: string | null): string[] {
  return ogcProcessHeaderLinks(header)
    .filter((link) => link.relations.some((relation) => relation.toLowerCase() === "monitor"))
    .map((link) => link.href);
}
