"""Regenerate the synthetic GRIB2 fixtures for tests/grib2.test.ts with ecCodes.

Each fixture is encoded by ecCodes (libaec for CCSDS), then decoded back by
ecCodes into a sidecar `.json` holding the values the TypeScript decoder must
reproduce, in scanning order, with `null` for a missing value.

Requires `pip install eccodes numpy`. Run from the repository root:

    python tests/fixtures/grib2/make_fixtures.py
"""

import json
import os

import eccodes
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
NI, NJ = 48, 24
MISSING = 9999.0


def field(seed: int) -> np.ndarray:
    """A field with a smooth part, a run of zeros and a noisy patch.

    The zeros encode as AEC zero blocks, the smooth part as split or
    second-extension blocks, and the noise as uncompressed blocks.

    Args:
        seed: Seeds the noisy patch.

    Returns:
        `NJ * NI` values, row-major.
    """
    rng = np.random.default_rng(seed)
    j, i = np.mgrid[0:NJ, 0:NI]
    values = 280 + 15 * np.sin(i / 7.0) * np.cos(j / 5.0)
    values[2:9, :] = 0.0
    values[14:20, 20:44] = rng.uniform(-50, 50, size=(6, 24))
    return values.ravel()


def latlon(handle: int, first_longitude: float) -> None:
    """Make the message a regular 7.5 degree latitude/longitude grid."""
    eccodes.codes_set(handle, "Ni", NI)
    eccodes.codes_set(handle, "Nj", NJ)
    eccodes.codes_set(handle, "latitudeOfFirstGridPointInDegrees", 86.25)
    eccodes.codes_set(handle, "latitudeOfLastGridPointInDegrees", -86.25)
    eccodes.codes_set(handle, "longitudeOfFirstGridPointInDegrees", first_longitude)
    eccodes.codes_set(handle, "longitudeOfLastGridPointInDegrees", first_longitude + 7.5 * (NI - 1))
    eccodes.codes_set(handle, "iDirectionIncrementInDegrees", 7.5)
    eccodes.codes_set(handle, "jDirectionIncrementInDegrees", 7.5)


def lambert(handle: int) -> None:
    """Make the message a small Lambert conformal grid scanned south to north (HRRR-like)."""
    eccodes.codes_set(handle, "gridType", "lambert")
    eccodes.codes_set(handle, "Nx", NI)
    eccodes.codes_set(handle, "Ny", NJ)
    eccodes.codes_set(handle, "latitudeOfFirstGridPointInDegrees", 21.138)
    eccodes.codes_set(handle, "longitudeOfFirstGridPointInDegrees", 237.28)
    eccodes.codes_set(handle, "LaDInDegrees", 38.5)
    eccodes.codes_set(handle, "LoVInDegrees", 262.5)
    eccodes.codes_set(handle, "Latin1InDegrees", 38.5)
    eccodes.codes_set(handle, "Latin2InDegrees", 38.5)
    eccodes.codes_set(handle, "DxInMetres", 3000)
    eccodes.codes_set(handle, "DyInMetres", 3000)
    eccodes.codes_set(handle, "jScansPositively", 1)


def write(name: str, grid, packing: str, values: np.ndarray, bits: int = 16) -> None:
    """Encode one fixture and its expected values.

    Args:
        name: The file stem.
        grid: Sets up the grid on the message.
        packing: The ecCodes `packingType`.
        values: The values to encode; NaN marks a missing point.
        bits: Bits per packed value.
    """
    handle = eccodes.codes_grib_new_from_samples("GRIB2")
    grid(handle)
    eccodes.codes_set(handle, "bitsPerValue", bits)
    missing = np.isnan(values)
    encoded = np.where(missing, MISSING, values)
    eccodes.codes_set(handle, "packingType", packing)
    eccodes.codes_set(handle, "missingValue", MISSING)
    # Real values first: turning the bitmap on over the sample's own data
    # leaves ecCodes nothing to code.
    eccodes.codes_set_values(handle, encoded)
    if missing.any():
        eccodes.codes_set(handle, "bitmapPresent", 1)
        eccodes.codes_set_values(handle, encoded)
    path = os.path.join(HERE, f"{name}.grib2")
    with open(path, "wb") as out:
        eccodes.codes_write(handle, out)
    eccodes.codes_release(handle)

    with open(path, "rb") as source:
        decoded = eccodes.codes_new_from_file(source, eccodes.CODES_PRODUCT_GRIB)
    result = eccodes.codes_get_double_array(decoded, "values")
    bitmap = eccodes.codes_get(decoded, "bitmapPresent")
    eccodes.codes_release(decoded)
    expected = [None if bitmap and v == MISSING else round(float(v), 9) for v in result]
    with open(os.path.join(HERE, f"{name}.json"), "w") as out:
        json.dump({"values": expected}, out, separators=(",", ":"))
        out.write("\n")


def main() -> None:
    """Write every fixture."""
    holes = field(3)
    holes[[5, 6, 7, 300, 301, 900]] = np.nan
    holes[NI * 20 : NI * 21] = np.nan

    write("ccsds", lambda h: latlon(h, 0.0), "grid_ccsds", field(1))
    write("ccsds-bitmap", lambda h: latlon(h, 0.0), "grid_ccsds", holes, bits=12)
    write(
        "complex-bitmap",
        lambda h: latlon(h, 0.0),
        "grid_complex_spatial_differencing",
        holes,
    )
    write("simple-bitmap", lambda h: latlon(h, 0.0), "grid_simple", holes, bits=10)
    write("lambert", lambert, "grid_complex_spatial_differencing", field(2))


if __name__ == "__main__":
    main()
