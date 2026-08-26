/**
 * Install the Web Crypto randomUUID API when the current WebView/origin does
 * not expose it. Strands calls globalThis.crypto.randomUUID() directly when it
 * creates chat messages, while some older WebViews and non-secure web origins
 * only expose getRandomValues.
 */
if (globalThis.crypto && typeof globalThis.crypto.randomUUID !== "function") {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: (): `${string}-${string}-${string}-${string}-${string}` => {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
      return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
        .slice(6, 8)
        .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
    },
  });
}
