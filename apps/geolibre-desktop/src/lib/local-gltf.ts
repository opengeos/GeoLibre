/** Validate a self-contained glTF 2 asset before embedding it in a project. */
export function localGltfMime(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  let json: unknown;
  let mime: string;
  if (bytes.length >= 4 && view.getUint32(0, true) === 0x46546c67) {
    if (
      bytes.length < 20 ||
      view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) !== bytes.length ||
      view.getUint32(16, true) !== 0x4e4f534a
    ) {
      throw new Error("invalid");
    }
    const jsonLength = view.getUint32(12, true);
    if (jsonLength % 4 || jsonLength > bytes.length - 20) throw new Error("invalid");
    let offset = 12;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) throw new Error("invalid");
      const length = view.getUint32(offset, true);
      if (length % 4 || length > bytes.length - offset - 8) throw new Error("invalid");
      offset += 8 + length;
    }
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
    mime = "model/gltf-binary";
  } else {
    json = JSON.parse(new TextDecoder().decode(bytes));
    mime = "model/gltf+json";
  }
  const asset = json as { asset?: { version?: string } } | null;
  if (asset?.asset?.version !== "2.0") throw new Error("invalid");
  if (hasExternalUri(json)) throw new Error("externalResources");
  return mime;
}

/**
 * Any `uri` anywhere in the asset can pull in a sidecar file, not just the
 * top-level `buffers`/`images` entries: texture extensions (KHR_texture_basisu,
 * MSFT_texture_dds) and vendor extensions carry their own. `extras` is
 * free-form application data, so it is skipped rather than validated.
 *
 * The walk keeps its own stack: a recursive one overflows on nesting that
 * `JSON.parse` itself accepts, turning a readable file into a generic "invalid
 * model" error.
 */
function hasExternalUri(root: unknown): boolean {
  const pending: unknown[] = [root];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const entry of value) pending.push(entry);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    for (const [key, entry] of Object.entries(value)) {
      if (key === "extras") continue;
      if (key === "uri" && typeof entry === "string" && !/^data:/i.test(entry)) return true;
      pending.push(entry);
    }
  }
  return false;
}

/**
 * Matches the inline GLB cap used for KML `<Model>` imports: base64 inflates
 * the bytes by ~4/3 in the saved project, so an uncapped pick can hang the tab
 * and produce an unusable `.geolibre.json`.
 */
export const MAX_LOCAL_GLTF_BYTES = 24 * 1024 * 1024;

/** Data URLs are portable across project saves, unlike session-only blob URLs. */
export async function embedLocalGltf(data: ArrayBuffer): Promise<string> {
  if (data.byteLength > MAX_LOCAL_GLTF_BYTES) throw new Error("modelTooLarge");
  const mime = localGltfMime(data);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([data], { type: mime }));
  });
}
