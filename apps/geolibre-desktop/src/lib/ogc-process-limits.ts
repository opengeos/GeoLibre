/** Limits shared by the process client and its development proxy. */
export const OGC_PROCESS_PROXY_PATH = "/__geolibre_process_proxy";
export const MAX_PROCESS_INPUT_BYTES = 1024 * 1024;
export const MAX_PROCESS_METADATA_BYTES = 2 * 1024 * 1024;
export const MAX_PROCESS_RESULT_BYTES = 128 * 1024 * 1024;
/** Match serde_json's default guard: the 128th nested container is rejected. */
export const MAX_PROCESS_INPUT_DEPTH = 127;

/** Accept Unicode scalars, including valid UTF-16 surrogate pairs. */
function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Validate the native JSON parser's depth and Unicode constraints before dispatch. */
export function processInputProblem(value: unknown): "inputDepth" | "inputUnicode" | undefined {
  const pending = [{ value, depth: 1 }];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (typeof value === "string" && !validUnicode(value)) return "inputUnicode";
    if (!value || typeof value !== "object") continue;
    if (depth > MAX_PROCESS_INPUT_DEPTH) return "inputDepth";
    for (const [key, child] of Object.entries(value)) {
      if (!validUnicode(key)) return "inputUnicode";
      pending.push({ value: child, depth: depth + 1 });
    }
  }
  return undefined;
}
