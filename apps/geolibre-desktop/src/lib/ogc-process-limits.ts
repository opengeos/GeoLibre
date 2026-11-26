/** Limits shared by the process client and its development proxy. */
export const OGC_PROCESS_PROXY_PATH = "/__geolibre_process_proxy";
export const MAX_PROCESS_INPUT_BYTES = 1024 * 1024;
export const MAX_PROCESS_METADATA_BYTES = 2 * 1024 * 1024;
export const MAX_PROCESS_RESULT_BYTES = 128 * 1024 * 1024;
/** Match serde_json's default guard: the 128th nested container is rejected. */
export const MAX_PROCESS_INPUT_DEPTH = 127;

/** Check JSON containers iteratively before serialization or native dispatch. */
export function processInputDepthAllowed(value: unknown): boolean {
  const pending = [{ value, depth: 1 }];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (!value || typeof value !== "object") continue;
    if (depth > MAX_PROCESS_INPUT_DEPTH) return false;
    for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
  }
  return true;
}
