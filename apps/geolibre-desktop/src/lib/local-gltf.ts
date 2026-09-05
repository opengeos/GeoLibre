/** Validate a self-contained glTF 2 asset before embedding it in a project. */
export function localGltfMime(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  let json: unknown;
  let mime: string;
  if (bytes.length >= 4 && view.getUint32(0, true) === 0x46546c67) {
    if (bytes.length < 20 || view.getUint32(4, true) !== 2 ||
        view.getUint32(8, true) !== bytes.length || view.getUint32(16, true) !== 0x4e4f534a) {
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
  const asset = json as {
    asset?: { version?: string };
    buffers?: Array<{ uri?: string }>;
    images?: Array<{ uri?: string }>;
  } | null;
  if (asset?.asset?.version !== "2.0") throw new Error("invalid");
  for (const resource of [...(asset.buffers ?? []), ...(asset.images ?? [])]) {
    if (resource.uri !== undefined && !/^data:/i.test(resource.uri)) {
      throw new Error("externalResources");
    }
  }
  return mime;
}

/** Data URLs are portable across project saves, unlike session-only blob URLs. */
export async function embedLocalGltf(data: ArrayBuffer): Promise<string> {
  const mime = localGltfMime(data);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([data], { type: mime }));
  });
}
