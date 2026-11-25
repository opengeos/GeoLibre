"""Validate and translate a raster output to a Cloud-Optimized GeoTIFF in place."""


def main() -> None:
    import json
    import os
    import stat
    import sys

    from rio_cogeo.cogeo import cog_translate, cog_validate
    from rio_cogeo.profiles import cog_profiles

    path = sys.argv[1]
    temporary = sys.argv[2]
    original_mode = stat.S_IMODE(os.stat(path).st_mode)
    valid, _, _ = cog_validate(path, quiet=True)
    if valid:
        print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"converted": False}))
        raise SystemExit(0)

    cog_translate(
        path,
        temporary,
        cog_profiles.get("deflate"),
        in_memory=False,
        quiet=True,
        use_cog_driver=False,
    )
    valid, errors, _ = cog_validate(temporary, quiet=True)
    if not valid:
        raise RuntimeError("COG validation failed: " + "; ".join(errors))
    os.chmod(temporary, original_mode)
    os.replace(temporary, path)
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"converted": True}))


if __name__ == "__main__":
    main()
