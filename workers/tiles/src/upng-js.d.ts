// Minimal ambient types for `upng-js`, which ships no type declarations. Only
// the decode/encode surface the reprojection Worker uses is described here.
declare module "upng-js" {
  interface UPNGImage {
    width: number;
    height: number;
    depth: number;
    ctype: number;
    frames: unknown[];
    tabs: Record<string, unknown>;
    data: Uint8Array;
  }

  /** Decode a PNG buffer into its raw (possibly palette/animation) form. */
  function decode(buffer: ArrayBuffer | Uint8Array): UPNGImage;

  /** Expand a decoded image to one RGBA8 ArrayBuffer per frame. */
  function toRGBA8(img: UPNGImage): ArrayBuffer[];

  /**
   * Encode RGBA8 frame buffers to a PNG ArrayBuffer. `cnum = 0` is lossless
   * (full colour, no palette quantization).
   */
  function encode(
    bufs: ArrayBuffer[],
    w: number,
    h: number,
    cnum: number,
    dels?: number[],
  ): ArrayBuffer;

  const UPNG: {
    decode: typeof decode;
    toRGBA8: typeof toRGBA8;
    encode: typeof encode;
  };
  export default UPNG;
}
