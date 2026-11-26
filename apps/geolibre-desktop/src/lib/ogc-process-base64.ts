/** Decode process bytes directly on modern hosts, with a compatibility fallback. */
export function decodeProcessBase64(value: string): Uint8Array<ArrayBuffer> {
  const fromBase64 = (
    Uint8Array as Uint8ArrayConstructor & {
      fromBase64?: (value: string) => Uint8Array<ArrayBuffer>;
    }
  ).fromBase64;
  if (fromBase64) return fromBase64(value);
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}
