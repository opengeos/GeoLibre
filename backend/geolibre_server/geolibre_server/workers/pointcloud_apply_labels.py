"""Rewrite LAS/LAZ/COPC point cloud labels and instance IDs."""


def main() -> None:
    import base64
    import json
    import os
    import struct
    import sys
    import zlib

    import laspy
    import numpy as np

    params = json.loads(sys.argv[1])
    with open(params["payload_path"], encoding="utf-8") as f:
        payload = json.load(f)
    os.unlink(params["payload_path"])
    input_path = params["input_path"]
    output_path = params["output_path"]

    # The same caps as geolibre.project's reader: inflated bytes per node and in
    # total, and decoded entries (each costs far more than its inflated bytes).
    NODE_LIMIT = 16 * 1024 * 1024
    budget = [256 * 1024 * 1024, 20_000_000]

    def decode(text, wide):
        inflater = zlib.decompressobj(-15)
        limit = min(NODE_LIMIT, budget[0])
        data = inflater.decompress(base64.b64decode(text), limit + 1)
        budget[0] -= len(data)
        if len(data) > limit or inflater.unconsumed_tail:
            raise ValueError("label record too large")
        edits, previous, at = {}, -1, 0

        def varint(at, max_shift):
            value = shift = 0
            while True:
                if at >= len(data):
                    raise ValueError("truncated label record")
                byte = data[at]
                at += 1
                value += (byte & 0x7F) << shift
                shift += 7
                if not byte & 0x80:
                    return value, at
                if shift > max_shift:
                    raise ValueError("varint too long")

        while at < len(data):
            delta, at = varint(at, 28)
            index = previous + 1 + delta
            previous = index
            if wide:
                value, at = varint(at, 28)
                if value > 0xFFFFFFFF:
                    raise ValueError("instance id out of range")
            else:
                if at >= len(data):
                    raise ValueError("truncated label record")
                value = data[at]
                at += 1
            edits[index] = value
        if len(edits) > budget[1]:
            raise ValueError("too many label entries")
        budget[1] -= len(edits)
        return edits

    def node_ranges(path, header):
        info = next(
            (
                v
                for v in header.vlrs
                if v.user_id.strip("\0").lower() == "copc" and v.record_id == 1
            ),
            None,
        )
        total = int(header.point_count)
        if info is None:
            return [("file", 0, total)]
        if hasattr(info, "hierarchy_root_offset"):
            root = (info.hierarchy_root_offset, info.hierarchy_root_size)
        else:
            root = struct.unpack_from("<QQ", bytes(info.record_data), 40)
        entry = struct.Struct("<4iQii")
        nodes = []
        file_size = os.path.getsize(path)
        # Every page lies inside the file, so the walk never reads more than it.
        remaining = [file_size]
        with open(path, "rb") as f:

            def page(offset, size, depth=0):
                if depth > 64:
                    raise ValueError("COPC hierarchy too deep")
                if offset < 0 or size < 0 or offset + size > file_size or size > remaining[0]:
                    raise ValueError("COPC hierarchy page lies outside the file")
                remaining[0] -= size
                f.seek(offset)
                raw = f.read(size)
                for at in range(0, len(raw) - entry.size + 1, entry.size):
                    d, x, y, z, off, nbytes, count = entry.unpack_from(raw, at)
                    if count == -1:
                        page(off, nbytes, depth + 1)
                    elif count > 0:
                        nodes.append((off, f"{d}-{x}-{y}-{z}", count))

            page(*root)
        nodes.sort()
        out, start = [], 0
        for _, key, count in nodes:
            out.append((key, start, count))
            start += count
        if start != total:
            raise ValueError(f"COPC hierarchy holds {start} points but the header says {total}")
        return out

    def flatten(encoded, ranges, wide):
        lookup = {key: (start, count) for key, start, count in ranges}
        idx, val = [], []
        for key, text in encoded.items():
            span = lookup.get(key)
            if span is None or not isinstance(text, str) or budget[0] <= 0 or budget[1] <= 0:
                continue
            cap = min(NODE_LIMIT, budget[0])
            before = budget[0]
            try:
                edits = decode(text, wide)
            except (ValueError, zlib.error) as error:
                # Skip one bad record, as the Python reader does, not the job, and
                # charge its full cap: bad records cannot bypass the budget.
                budget[0] = before - cap
                print(f"Skipped the labels of node {key}: {error}")
                continue
            for offset, value in edits.items():
                if 0 <= offset < span[1]:
                    idx.append(span[0] + offset)
                    val.append(value)
        order = np.argsort(np.asarray(idx, dtype=np.int64), kind="stable")
        return np.asarray(idx, dtype=np.int64)[order], np.asarray(val, dtype=np.int64)[order]

    def not_copc(vlr):
        user = vlr.user_id.strip("\0").lower()
        return user not in ("copc", "laszip encoded")

    with laspy.open(input_path) as reader:
        source = reader.header
        ranges = node_ranges(input_path, source)
        li, lv = flatten(payload.get("labels") or {}, ranges, False)
        ii, iv = flatten(payload.get("instances") or {}, ranges, True)
        total = int(source.point_count)
        print(f"Applying {len(li)} labels and {len(ii)} instance ids to {total} points")
        fmt = source.point_format.id
        if fmt < 6 and len(lv) and int(lv.max()) > 31:
            # LAS 1.4 format 6/7 for classes above 31, keeping the metadata, the
            # extra-bytes dimensions and the CRS (as WKT, which 6-10 require).
            # Waveform formats keep their packets in 9/10; colour in 7.
            target = {4: 9, 5: 10}.get(fmt, 7 if fmt in (2, 3) else 6)
            header = laspy.LasHeader(point_format=target, version="1.4")
            header.scales = source.scales
            header.offsets = source.offsets
            for name in ("system_identifier", "generating_software", "creation_date"):
                try:
                    setattr(header, name, getattr(source, name))
                except (AttributeError, ValueError):
                    pass
            extra = [
                laspy.ExtraBytesParams(
                    name=d.name,
                    type=d.type_str() if callable(d.type_str) else d.type_str,
                    description=d.description or "",
                    offsets=d.offsets,
                    scales=d.scales,
                    no_data=d.no_data,
                )
                for d in source.point_format.extra_dimensions
            ]
            if extra:
                header.add_extra_dims(extra)
            try:
                crs = source.parse_crs()
            except Exception:
                crs = None
            geotiff = {34735, 34736, 34737}

            def keep(v):
                user = v.user_id.strip("\0")
                if not not_copc(v) or (user == "LASF_Spec" and v.record_id == 4):
                    return False
                return not (
                    crs is not None and user == "LASF_Projection" and v.record_id in geotiff
                )

            header.vlrs.extend(v for v in source.vlrs if keep(v))
            if crs is not None:
                header.add_crs(crs)
        else:
            import copy

            header = copy.deepcopy(source)
            header.vlrs = [v for v in header.vlrs if not_copc(v)]
            if getattr(header, "evlrs", None) is not None:
                header.evlrs = [v for v in header.evlrs if not_copc(v)]
        if len(ii) and "instance" not in header.point_format.dimension_names:
            header.add_extra_dims(
                [
                    laspy.ExtraBytesParams(
                        name="instance",
                        type=np.uint32,
                        description="Object (instance) id, 0 = none",
                    )
                ]
            )
        written = 0
        with laspy.open(output_path, mode="w", header=header) as writer:
            for chunk in reader.chunk_iterator(1_000_000):
                n = len(chunk)
                points = laspy.ScaleAwarePointRecord.zeros(n, header=writer.header)
                names = set(points.point_format.dimension_names)
                for name in chunk.point_format.dimension_names:
                    if name in names:
                        points[name] = chunk[name]
                if (
                    "scan_angle_rank" in chunk.point_format.dimension_names
                    and "scan_angle" in names
                ):
                    rank = np.asarray(chunk["scan_angle_rank"], dtype=np.float64)
                    points["scan_angle"] = np.round(rank / 0.006).astype(np.int16)
                end = written + n
                for index, value, name in ((li, lv, "classification"), (ii, iv, "instance")):
                    if not len(index) or name not in names:
                        continue
                    lo, hi = np.searchsorted(index, [written, end])
                    if hi > lo:
                        column = np.asarray(points[name]).copy()
                        column[index[lo:hi] - written] = value[lo:hi]
                        points[name] = column
                writer.write_points(points)
                written = end
                print(f"Wrote {written} points")

    result = {
        "output_path": output_path,
        "points": written,
        "relabelled": int(len(li)),
        "instanced": int(len(ii)),
    }
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps(result))


if __name__ == "__main__":
    main()
