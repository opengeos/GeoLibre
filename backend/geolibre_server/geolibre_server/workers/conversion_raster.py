"""Convert rasters to Cloud-Optimized GeoTIFF via rio-cogeo."""


def main() -> None:
    import json
    import sys

    from rio_cogeo.cogeo import cog_translate, cog_validate
    from rio_cogeo.profiles import cog_profiles

    params = json.loads(sys.argv[1])
    input_path = params["input_path"]
    output_path = params["output_path"]
    compression = params["compression"]

    profile = cog_profiles.get(compression)
    print(f"Converting {input_path} using the {compression} COG profile")
    cog_translate(
        input_path,
        output_path,
        profile,
        in_memory=False,
        quiet=True,
        use_cog_driver=False,
    )
    valid, errors, warnings = cog_validate(output_path, quiet=True)
    for message in warnings:
        print(f"Warning: {message}")
    for message in errors:
        print(f"Error: {message}")
    if not valid:
        raise SystemExit("Output failed COG validation: " + "; ".join(errors))
    print(f"Wrote valid Cloud Optimized GeoTIFF to {output_path}")
    print(
        "__GEOLIBRE_CONVERSION_RESULT__"
        + json.dumps({"valid": valid, "warnings": warnings, "output_path": output_path})
    )


if __name__ == "__main__":
    main()
