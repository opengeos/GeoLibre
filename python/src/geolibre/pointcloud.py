"""Point cloud label files: pre-labelling and writing labels into LAS/LAZ.

The app's point cloud annotator saves labels in the project keyed by each
point's stable identity: the source node key (a COPC octree key such as
``"2-1-0-1"``, or ``"file"`` for a LAS/LAZ loaded whole) and the point's index
within that node. This module connects those keys to a file on disk:

* :func:`point_node_ranges` maps node keys to the file's point order (COPC
  points are stored node by node, in the order of their chunks);
* :func:`prelabel_point_cloud` runs a Whitebox classifier on a local file and
  returns the changed classes as project labels, like the app's Pre-label;
* :func:`write_labeled_point_cloud` rewrites a LAS/LAZ/COPC file with the
  project's labels (and instance ids) applied, streaming chunk by chunk so
  files larger than memory work.

``laspy[lazrs]`` (and ``whitebox-workflows`` for pre-labelling) come with the
``geolibre[pointcloud]`` extra.
"""

from __future__ import annotations

import base64
import struct
import tempfile
import zlib
from pathlib import Path
from typing import Any

from . import project as _project

PRELABEL_TOOLS = {
    # Tool id -> (whitebox-workflows tool, parameters); matches the app's
    # Pre-label choices (prelabel.ts), which run the same tools in WebAssembly.
    "ground": ("improved_ground_point_filter", {"classify": True}),
    "ground-vegetation": ("classify_lidar", {}),
}
"""Pre-label tools: ``ground`` separates ground (2) from everything else (1);
``ground-vegetation`` also marks vegetation."""

_COPC_HIERARCHY_ENTRY = struct.Struct("<4iQii")


def _require_laspy() -> Any:
    """Import laspy with a helpful error when the extra is missing.

    Returns:
        The laspy module.

    Raises:
        ImportError: When laspy is not installed.
    """
    try:
        import laspy
    except ImportError as error:  # pragma: no cover - exercised without the extra
        raise ImportError(
            "Point cloud files need laspy: pip install 'geolibre[pointcloud]'"
        ) from error
    return laspy


def point_node_ranges(path: str | Path) -> list[tuple[str, int, int]]:
    """Map a point cloud file's node keys to its point order.

    Args:
        path: A LAS, LAZ or COPC file.

    Returns:
        ``(node_key, first_point, point_count)`` for each node, in file order.
        A plain LAS/LAZ is one ``"file"`` node holding every point.
    """
    laspy = _require_laspy()
    with laspy.open(str(path)) as reader:
        header = reader.header
        info = next(
            (
                vlr
                for vlr in header.vlrs
                if vlr.user_id.strip("\0").lower() == "copc" and vlr.record_id == 1
            ),
            None,
        )
        total = int(header.point_count)
    if info is None:
        return [("file", 0, total)]
    if hasattr(info, "hierarchy_root_offset"):
        # laspy parses the COPC info record itself.
        root_offset, root_size = info.hierarchy_root_offset, info.hierarchy_root_size
    else:
        root_offset, root_size = struct.unpack_from("<QQ", bytes(info.record_data), 40)
    nodes: list[tuple[int, str, int]] = []
    file_size = Path(path).stat().st_size
    # Every page lies inside the file, so the walk never reads more than it.
    budget = [file_size]
    with open(path, "rb") as file:

        def read_page(offset: int, size: int, depth: int = 0) -> None:
            if depth > 64:
                raise ValueError("COPC hierarchy is too deep")
            if offset < 0 or size < 0 or offset + size > file_size or size > budget[0]:
                raise ValueError("COPC hierarchy page lies outside the file")
            budget[0] -= size
            file.seek(offset)
            page = file.read(size)
            for at in range(
                0, len(page) - _COPC_HIERARCHY_ENTRY.size + 1, _COPC_HIERARCHY_ENTRY.size
            ):
                d, x, y, z, entry_offset, byte_size, count = _COPC_HIERARCHY_ENTRY.unpack_from(
                    page, at
                )
                if count == -1:
                    read_page(entry_offset, byte_size, depth + 1)
                elif count > 0:
                    nodes.append((entry_offset, f"{d}-{x}-{y}-{z}", count))

        read_page(root_offset, root_size)
    nodes.sort()
    ranges: list[tuple[str, int, int]] = []
    start = 0
    for _, key, count in nodes:
        ranges.append((key, start, count))
        start += count
    if start != total:
        raise ValueError(f"COPC hierarchy holds {start} points but the header says {total}")
    return ranges


def encode_point_label_node(edits: dict[int, int], wide: bool = False) -> str:
    """Encode one node's edits the way the app's label store does.

    Args:
        edits: Point index within the node -> class code (or instance id).
        wide: Encode values as varints (instance ids) instead of class bytes.

    Returns:
        base64 of raw-DEFLATE compressed (delta-varint index, value) pairs.
    """

    def varint(value: int, out: bytearray) -> None:
        while value >= 0x80:
            out.append((value & 0x7F) | 0x80)
            value >>= 7
        out.append(value)

    out = bytearray()
    previous = -1
    for index in sorted(edits):
        varint(index - previous - 1, out)
        previous = index
        value = int(edits[index])
        if wide:
            varint(value & 0xFFFFFFFF, out)
        else:
            out.append(value & 0xFF)
    compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
    return base64.b64encode(compressor.compress(bytes(out)) + compressor.flush()).decode()


def _global_edits(
    nodes: dict[str, dict[int, int]], ranges: list[tuple[str, int, int]]
) -> tuple[Any, Any]:
    """Flatten per-node edits to sorted file indices and values.

    Args:
        nodes: Node key -> {index within node: value}.
        ranges: The file's node ranges (:func:`point_node_ranges`).

    Returns:
        ``(indices, values)`` numpy arrays, ascending by index. Edits for nodes
        the file does not have, or past a node's end, are dropped.
    """
    import numpy as np

    lookup = {key: (start, count) for key, start, count in ranges}
    indices: list[int] = []
    values: list[int] = []
    for key, edits in nodes.items():
        span = lookup.get(key)
        if span is None:
            continue
        start, count = span
        for offset, value in edits.items():
            if 0 <= offset < count:
                indices.append(start + offset)
                values.append(value)
    order = np.argsort(np.asarray(indices, dtype=np.int64), kind="stable")
    return (
        np.asarray(indices, dtype=np.int64)[order],
        np.asarray(values, dtype=np.int64)[order],
    )


def _read_classes(path: str | Path) -> Any:
    """Read only a file's classification codes, chunk by chunk.

    Args:
        path: A LAS/LAZ/COPC file.

    Returns:
        One int64 class code per point, in file order.
    """
    import numpy as np

    laspy = _require_laspy()
    with laspy.open(str(path)) as reader:
        classes = np.empty(int(reader.header.point_count), dtype=np.int64)
        at = 0
        for chunk in reader.chunk_iterator(1_000_000):
            classes[at : at + len(chunk)] = np.asarray(chunk.classification)
            at += len(chunk)
    return classes[:at]


def prelabel_point_cloud(
    path: str | Path,
    tool: str = "ground",
    *,
    current: dict[str, dict[int, int]] | None = None,
    only_unclassified: bool = True,
    protected_classes: tuple[int, ...] = (),
) -> dict[str, dict[int, int]]:
    """Run a Whitebox classifier on a local file and return project labels.

    Mirrors the app's Pre-label: the tool classifies every point in place
    (same count, same order), and the points it changed become label edits.

    Args:
        path: The LAS/LAZ/COPC file the labels are for (a local copy of the
            project's point cloud source).
        tool: ``"ground"`` or ``"ground-vegetation"`` (see :data:`PRELABEL_TOOLS`).
        current: The project's existing labels for this source (node key ->
            {index: class}); they count as the points' current classes, so
            points the user already labelled are respected.
        only_unclassified: Only relabel points still 0 or 1.
        protected_classes: Classes whose points keep their class.

    Returns:
        Node key -> {index within node: new class} for the points that change.

    Raises:
        ValueError: For an unknown tool, or a tool result with a different
            number of points.
        ImportError: When whitebox-workflows or laspy is missing.
    """
    import numpy as np

    _require_laspy()
    if tool not in PRELABEL_TOOLS:
        raise ValueError(f"tool must be one of {sorted(PRELABEL_TOOLS)}")
    try:
        import whitebox_workflows
    except ImportError as error:  # pragma: no cover - exercised without the extra
        raise ImportError(
            "Pre-labelling needs whitebox-workflows: pip install 'geolibre[pointcloud]'"
        ) from error
    ranges = point_node_ranges(path)
    before = _read_classes(path)
    if current:
        indices, values = _global_edits(current, ranges)
        before[indices] = values
    tool_name, parameters = PRELABEL_TOOLS[tool]
    wbe = whitebox_workflows.WbEnvironment()
    with tempfile.TemporaryDirectory() as tmp:
        output = str(Path(tmp) / "prelabel.las")
        getattr(wbe.lidar, tool_name)(input=str(path), output=output, **parameters)
        after = _read_classes(output)
    if len(after) != len(before):
        raise ValueError(
            f"The tool returned {len(after)} points for {len(before)}; it must keep every point"
        )
    changed = after != before
    if only_unclassified:
        changed &= (before == 0) | (before == 1)
    if protected_classes:
        changed &= ~np.isin(before, list(protected_classes))
    labels: dict[str, dict[int, int]] = {}
    for key, start, count in ranges:
        hits = np.nonzero(changed[start : start + count])[0]
        if len(hits):
            labels[key] = {int(i): int(after[start + i]) for i in hits}
    return labels


def write_labeled_point_cloud(
    path: str | Path,
    output: str | Path,
    labels: dict[str, dict[int, int]],
    instances: dict[str, dict[int, int]] | None = None,
    *,
    chunk_size: int = 1_000_000,
) -> dict[str, int]:
    """Rewrite a point cloud file with project labels applied.

    Streams the file chunk by chunk, so it works on files larger than memory.
    A COPC input is written as plain LAS/LAZ (by ``output``'s extension); a
    legacy point format (0-5) is upgraded to LAS 1.4 (6, 7, or 9/10 for the
    waveform formats) when a label needs a class above 31. Instance ids add a
    uint32 ``instance`` extra dimension, like the app's LAS export.

    Args:
        path: The source LAS/LAZ/COPC file.
        output: The ``.las`` or ``.laz`` file to write.
        labels: Node key -> {index within node: class}.
        instances: Node key -> {index within node: instance id}, optional.
        chunk_size: Points read and written per step.

    Returns:
        ``{"points", "relabelled", "instanced"}`` counts.
    """
    import copy

    import numpy as np

    laspy = _require_laspy()
    # Writing opens (and truncates) the output while the input is being read.
    if Path(path).expanduser().resolve() == Path(output).expanduser().resolve():
        raise ValueError("The output must be a different file from the input.")
    ranges = point_node_ranges(path)
    label_index, label_value = _global_edits(labels, ranges)
    inst_index, inst_value = _global_edits(instances or {}, ranges)
    with laspy.open(str(path)) as reader:
        source = reader.header
        fmt = source.point_format.id
        needs_upgrade = fmt < 6 and bool(len(label_value)) and int(label_value.max()) > 31
        if needs_upgrade:
            header = _upgraded_header(source)
        else:
            header = copy.deepcopy(source)
            header.vlrs = [vlr for vlr in header.vlrs if not _is_copc_or_laszip(vlr)]
            if hasattr(header, "evlrs") and header.evlrs is not None:
                header.evlrs = [vlr for vlr in header.evlrs if not _is_copc_or_laszip(vlr)]
        with_instances = bool(len(inst_index))
        if with_instances and "instance" not in header.point_format.dimension_names:
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
        with laspy.open(str(output), mode="w", header=header) as writer:
            for chunk in reader.chunk_iterator(chunk_size):
                count = len(chunk)
                points = laspy.ScaleAwarePointRecord.zeros(count, header=writer.header)
                target_names = set(points.point_format.dimension_names)
                for name in chunk.point_format.dimension_names:
                    if name in target_names:
                        points[name] = chunk[name]
                if (
                    "scan_angle_rank" in chunk.point_format.dimension_names
                    and "scan_angle" in target_names
                ):
                    points["scan_angle"] = np.round(
                        np.asarray(chunk["scan_angle_rank"], dtype=np.float64) / 0.006
                    ).astype(np.int16)
                end = written + count
                for index, value, name in (
                    (label_index, label_value, "classification"),
                    (inst_index, inst_value, "instance"),
                ):
                    if not len(index) or name not in target_names:
                        continue
                    lo, hi = np.searchsorted(index, [written, end])
                    if hi > lo:
                        column = np.asarray(points[name]).copy()
                        column[index[lo:hi] - written] = value[lo:hi]
                        points[name] = column
                writer.write_points(points)
                written = end
    return {
        "points": written,
        "relabelled": int(len(label_index)),
        "instanced": int(len(inst_index)),
    }


_GEOTIFF_RECORDS = {34735, 34736, 34737}


def _upgraded_header(source: Any) -> Any:
    """A LAS 1.4 header (format 6, 7, 9 or 10) carrying a legacy header's metadata.

    Keeps the scales and offsets, identifiers, creation date, extra-bytes
    dimensions and CRS; the CRS is rewritten as WKT (formats 6-10 require it)
    when pyproj can parse it, else the GeoTIFF records are kept as they are.

    Args:
        source: The legacy (format 0-5) laspy header.

    Returns:
        The new header.
    """
    laspy = _require_laspy()
    fmt = source.point_format.id
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
            name=dim.name,
            type=dim.type_str() if callable(dim.type_str) else dim.type_str,
            description=dim.description or "",
            offsets=dim.offsets,
            scales=dim.scales,
            no_data=dim.no_data,
        )
        for dim in source.point_format.extra_dimensions
    ]
    if extra:
        header.add_extra_dims(extra)
    try:
        crs = source.parse_crs()
    except Exception:  # pyproj missing, or GeoKeys it cannot read
        crs = None

    def keep(vlr: Any) -> bool:
        user = vlr.user_id.strip("\0")
        if _is_copc_or_laszip(vlr) or (user == "LASF_Spec" and vlr.record_id == 4):
            return False
        return not (
            crs is not None and user == "LASF_Projection" and vlr.record_id in _GEOTIFF_RECORDS
        )

    header.vlrs.extend(vlr for vlr in source.vlrs if keep(vlr))
    if crs is not None:
        header.add_crs(crs)
    return header


def _is_copc_or_laszip(vlr: Any) -> bool:
    """Whether a VLR describes COPC structure or LASzip compression.

    Args:
        vlr: A laspy VLR.

    Returns:
        True for the COPC info/hierarchy and LASzip records, which do not
        carry over to a rewritten file (laspy writes its own LASzip record).
    """
    user = vlr.user_id.strip("\0").lower()
    return user == "copc" or user == "laszip encoded"


def labels_for_source(project: dict[str, Any], url: str) -> tuple[dict, dict]:
    """The labels and instance ids a project holds for one source URL.

    Args:
        project: A project dict.
        url: The point cloud's source URL.

    Returns:
        ``(labels, instances)``, each node key -> {index within node: value}.
    """
    annotations = _project.point_cloud_annotations(project)
    return annotations["labels"].get(url, {}), annotations["instances"].get(url, {})
