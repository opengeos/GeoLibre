/**
 * A decoder for CCSDS 121.0-B adaptive entropy coding (extended Rice), the compression behind
 * GRIB2 data representation template 5.42. ECMWF's open data packs every field this way.
 *
 * A port of the decoding side of libaec, which is what eccodes and gribberish link against. It
 * returns the integer samples, before GRIB's reference value and scale factors are applied.
 */

/** Option bits of GRIB2 template 5.42 octet 22, which are libaec's `AEC_DATA_*` flags. */
export const AEC_DATA_SIGNED = 1;
export const AEC_DATA_3BYTE = 2;
export const AEC_DATA_MSB = 4;
export const AEC_DATA_PREPROCESS = 8;
export const AEC_RESTRICTED = 16;
export const AEC_PAD_RSI = 32;

/** Blocks per segment: the unit a run of zero blocks is counted within. */
const SEGMENT_BLOCKS = 64;
/** The zero-block count that means "to the end of the segment". */
const ROS = 5;

/** The parameters of one AEC stream. */
export interface AecOptions {
  /** Bits per sample, 1 to 32. */
  bitsPerSample: number;
  /** Samples per block: 8, 16, 32 or 64. */
  blockSize: number;
  /** Blocks per reference sample interval. */
  rsi: number;
  /** The `AEC_*` option bits. */
  flags: number;
}

/** A big-endian bit reader over a byte buffer. */
class BitReader {
  private readonly bytes: Uint8Array;
  private position = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  /** Read `count` bits (0 to 32) as an unsigned number. */
  read(count: number): number {
    let value = 0;
    let remaining = count;
    while (remaining > 0) {
      const byte = this.bytes[this.position >>> 3];
      if (byte === undefined) throw new Error("AEC stream ended early");
      const offset = this.position & 7;
      const take = Math.min(8 - offset, remaining);
      const bits = (byte >>> (8 - offset - take)) & ((1 << take) - 1);
      // Multiplication rather than a shift: a 32-bit sample would overflow a signed shift.
      value = value * (1 << take) + bits;
      this.position += take;
      remaining -= take;
    }
    return value;
  }

  /** Read a fundamental sequence: the count of zero bits before the next one bit. */
  readFs(): number {
    let count = 0;
    for (;;) {
      const byte = this.bytes[this.position >>> 3];
      if (byte === undefined) throw new Error("AEC stream ended early");
      const offset = this.position & 7;
      // Skip a whole zero byte at once when aligned on it.
      if (offset === 0 && byte === 0) {
        count += 8;
        this.position += 8;
        continue;
      }
      if ((byte >>> (7 - offset)) & 1) {
        this.position += 1;
        return count;
      }
      count += 1;
      this.position += 1;
    }
  }

  /** Skip to the next byte boundary. */
  align(): void {
    this.position = (this.position + 7) & ~7;
  }
}

/** The second-extension table: the pair a codeword `m` stands for is `(beta - d1, d1)`. */
const SECOND_EXTENSION = (() => {
  const table: Array<[beta: number, start: number]> = [];
  for (let beta = 0; beta < 13; beta += 1) {
    const start = table.length;
    for (let j = 0; j <= beta; j += 1) table.push([beta, start]);
  }
  return table;
})();

/** The width of a block's option id, from CCSDS 121.0-B table 5-1 and libaec's restricted set. */
function idLength(bitsPerSample: number, flags: number): number {
  if (bitsPerSample > 16) return 5;
  if (bitsPerSample > 8) return 4;
  if (flags & AEC_RESTRICTED && bitsPerSample <= 4) return bitsPerSample <= 2 ? 1 : 2;
  return 3;
}

/**
 * Undo the unit-delay predictor: map each residual back to a sample, given the one before it.
 *
 * The encoder maps a prediction error `delta` onto a non-negative residual that stays within the
 * sample range: small errors interleave by sign (`2|delta|` or `2|delta| - 1`), and an error past
 * the nearer range edge (`theta` away) is sent as `theta + |delta|`, whose sign is implied.
 */
function unmapResidual(residual: number, previous: number, min: number, max: number): number {
  const theta = Math.min(previous - min, max - previous);
  if (residual <= 2 * theta) {
    return residual & 1 ? previous - (residual + 1) / 2 : previous + residual / 2;
  }
  return theta === previous - min ? previous + (residual - theta) : previous - (residual - theta);
}

/**
 * Decode an AEC stream into its samples.
 *
 * Args:
 *   bytes: The compressed stream (a GRIB2 section 7 payload).
 *   count: How many samples it holds; the final interval is cut short there.
 *   options: The stream parameters from GRIB2 template 5.42.
 *
 * Returns:
 *   The samples. Signed streams decode to their two's-complement values.
 */
export function decodeAec(bytes: Uint8Array, count: number, options: AecOptions): Float64Array {
  const { bitsPerSample, blockSize, rsi, flags } = options;
  if (bitsPerSample < 1 || bitsPerSample > 32) {
    throw new Error(`Unsupported AEC sample width: ${bitsPerSample}`);
  }
  if (![8, 16, 32, 64].includes(blockSize) || rsi < 1) {
    throw new Error(`Unsupported AEC block size ${blockSize} or interval ${rsi}`);
  }
  const signed = (flags & AEC_DATA_SIGNED) !== 0;
  const preprocess = (flags & AEC_DATA_PREPROCESS) !== 0;
  const idBits = idLength(bitsPerSample, flags);
  const uncompressedId = (1 << idBits) - 1;
  const half = 2 ** (bitsPerSample - 1);
  const min = signed ? -half : 0;
  const max = signed ? half - 1 : 2 ** bitsPerSample - 1;
  const toSigned = (value: number) => (signed && value >= half ? value - 2 * half : value);

  const reader = new BitReader(bytes);
  const out = new Float64Array(count);
  let written = 0;
  // The residuals of one interval, mapped back to samples as each is read.
  let previous = 0;
  const emit = (value: number, isReference: boolean) => {
    if (written >= count) return;
    if (!preprocess) {
      out[written++] = toSigned(value);
    } else if (isReference) {
      previous = toSigned(value);
      out[written++] = previous;
    } else {
      previous = unmapResidual(value, previous, min, max);
      out[written++] = previous;
    }
  };

  while (written < count) {
    // One reference sample interval.
    for (let block = 0; block < rsi && written < count; block += 1) {
      const reference = preprocess && block === 0;
      const id = reader.read(idBits);
      if (id === 0) {
        const secondExtension = reader.read(1) === 1;
        if (reference) emit(reader.read(bitsPerSample), true);
        if (secondExtension) {
          for (let index = reference ? 1 : 0; index < blockSize;) {
            const m = reader.readFs();
            const pair = SECOND_EXTENSION[m];
            if (!pair) throw new Error("Invalid AEC second-extension code");
            const d1 = m - pair[1];
            if ((index & 1) === 0) {
              emit(pair[0] - d1, false);
              index += 1;
            }
            emit(d1, false);
            index += 1;
          }
        } else {
          let zeroBlocks = reader.readFs() + 1;
          if (zeroBlocks === ROS) {
            zeroBlocks = Math.min(rsi - block, SEGMENT_BLOCKS - (block % SEGMENT_BLOCKS));
          } else if (zeroBlocks > ROS) {
            zeroBlocks -= 1;
          }
          const zeros = zeroBlocks * blockSize - (reference ? 1 : 0);
          for (let index = 0; index < zeros; index += 1) emit(0, false);
          block += zeroBlocks - 1;
        }
      } else if (id === uncompressedId) {
        if (reference) emit(reader.read(bitsPerSample), true);
        for (let index = reference ? 1 : 0; index < blockSize; index += 1) {
          emit(reader.read(bitsPerSample), false);
        }
      } else {
        // Split sample: every sample's fundamental sequence first, then every sample's k low bits.
        const k = id - 1;
        if (reference) emit(reader.read(bitsPerSample), true);
        const length = blockSize - (reference ? 1 : 0);
        const high = new Array<number>(length);
        for (let index = 0; index < length; index += 1) high[index] = reader.readFs();
        for (let index = 0; index < length; index += 1) {
          emit(high[index] * 2 ** k + (k ? reader.read(k) : 0), false);
        }
      }
    }
    if (flags & AEC_PAD_RSI) reader.align();
  }
  return out;
}
