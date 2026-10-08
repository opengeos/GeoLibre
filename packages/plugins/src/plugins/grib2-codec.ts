/**
 * The `gribberish` Zarr codec, for zarrita: decodes the GRIB2 message a virtual Icechunk chunk
 * points at (see {@link decodeGrib2}).
 *
 * Registered in zarrita's shared codec registry, which `@carbonplan/zarr-layer` reads chunks
 * through too, so one registration serves both the panel's own reads and the map layer.
 */

import { decodeGrib2, orientGrib2Field } from "./grib2";

/** The codec configuration dynamical.org writes. `var` names the field and needs no decoding. */
export interface GribberishConfiguration {
  var?: string;
  adjust_longitude_range?: boolean;
  north_up?: boolean;
}

type FloatArrayConstructor = Float32ArrayConstructor | Float64ArrayConstructor;

/** The decoded chunk, in zarrita's `Chunk` shape. */
interface DecodedChunk {
  data: Float32Array | Float64Array;
  shape: number[];
  stride: number[];
}

function strides(shape: readonly number[]): number[] {
  const out = new Array<number>(shape.length);
  let step = 1;
  for (let index = shape.length - 1; index >= 0; index -= 1) {
    out[index] = step;
    step *= shape[index];
  }
  return out;
}

/** An array-to-bytes codec that reads a GRIB2 message into a chunk. Decode only. */
export class GribberishCodec {
  readonly kind = "array_to_bytes";

  constructor(
    private readonly configuration: GribberishConfiguration,
    private readonly shape: number[],
    private readonly ArrayType: FloatArrayConstructor,
  ) {}

  /**
   * Build the codec from its metadata, as zarrita's registry calls it.
   *
   * Args:
   *   configuration: The codec's `configuration` object.
   *   meta: The chunk's shape and data type.
   *
   * Returns:
   *   The codec.
   */
  static fromConfig(
    configuration: GribberishConfiguration | undefined,
    meta: { shape: number[]; dataType: string },
  ): GribberishCodec {
    if (meta.dataType !== "float64" && meta.dataType !== "float32") {
      throw new Error(`gribberish codec does not support data type: ${meta.dataType}`);
    }
    return new GribberishCodec(
      configuration ?? {},
      meta.shape,
      meta.dataType === "float64" ? Float64Array : Float32Array,
    );
  }

  encode(): never {
    throw new Error("gribberish codec cannot encode");
  }

  /**
   * Decode one chunk.
   *
   * Args:
   *   bytes: The GRIB2 message.
   *
   * Returns:
   *   The chunk, north-up and west to east when the configuration asks for it.
   */
  decode(bytes: Uint8Array): DecodedChunk {
    const field = decodeGrib2(bytes);
    const values = orientGrib2Field(field, {
      northUp: this.configuration.north_up ?? false,
      adjustLongitudeRange: this.configuration.adjust_longitude_range ?? false,
    });
    const size = this.shape.reduce((product, length) => product * length, 1);
    if (values.length !== size) {
      throw new Error(
        `GRIB2 field holds ${values.length} values for a chunk of ${size} (${this.shape.join("×")})`,
      );
    }
    const data =
      this.ArrayType === Float64Array ? values : (new this.ArrayType(values) as Float32Array);
    return { data, shape: [...this.shape], stride: strides(this.shape) };
  }
}

let registration: Promise<void> | null = null;

/**
 * Teach zarrita the `gribberish` codec. Idempotent; call before reading a virtual repository.
 */
export function registerGribberishCodec(): Promise<void> {
  registration ??= import("zarrita").then(({ registry }) => {
    if (!registry.has("gribberish")) {
      // zarrita's registry is typed for its own codec classes. This one honours the same contract
      // (`kind`, static `fromConfig(config, meta)`, `decode(bytes)` returning `{ data, shape,
      // stride }`), checked against zarrita 0.7.5's `codecs.js`; a change there shows up in
      // tests/grib2.test.ts, which reads through the registered codec.
      registry.set("gribberish", () => GribberishCodec as never);
    }
  });
  return registration;
}
