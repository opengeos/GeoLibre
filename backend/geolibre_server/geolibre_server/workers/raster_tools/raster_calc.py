"""Raster processing worker for 'raster-calc'."""


def main() -> None:
    import ast
    import json
    import re
    import sys

    import numpy as np
    import rasterio

    params = json.loads(sys.argv[1])
    input_path = params["input_path"]
    output_path = params["output_path"]
    expression = str(params.get("expression", "") or "").strip()
    if not expression:
        raise SystemExit("Expression is required")
    # Dunder access (e.g. ``A.__class__.__bases__[0].__subclasses__()``) is the
    # standard way to break out of an ``eval`` with an emptied ``__builtins__``;
    # rejecting it keeps band math from reaching arbitrary objects. This check is
    # load-bearing alongside the empty ``__builtins__`` and the np-free namespace
    # below: do not relax it (e.g. to allow a single ``_``) without replacing it.
    if "__" in expression:
        raise SystemExit("Expression may not contain '__'")
    b_path = str(params.get("b_path", "") or "").strip()
    c_path = str(params.get("c_path", "") or "").strip()
    nodata = -9999.0

    def load_bands(path, letter, namespace, base):
        # ``base`` is None for raster A, else (shape, crs, transform) of A to validate against.
        with rasterio.open(path) as ds:
            shape = (ds.height, ds.width)
            crs = ds.crs
            transform = ds.transform
            if base is not None:
                if shape != base[0]:
                    raise SystemExit(
                        f"Raster {letter} ({ds.width}x{ds.height}) must match the "
                        f"dimensions of raster A ({base[0][1]}x{base[0][0]})."
                    )
                # Identical dimensions over different CRSs would compute band math on
                # spatially unaligned pixels; reject rather than emit a silent
                # mismatch.
                if crs != base[1]:
                    raise SystemExit(
                        f"Raster {letter} CRS ({crs}) does not match raster A "
                        f"({base[1]}); reproject before running the calculator."
                    )
                if not transform.almost_equals(base[2]):
                    raise SystemExit(
                        f"Raster {letter} geotransform does not match raster A; "
                        "align grids before running the calculator."
                    )
            bands = [
                np.ma.filled(ds.read(i, masked=True).astype("float64"), np.nan)
                for i in range(1, ds.count + 1)
            ]
            profile = ds.profile.copy()
        # ``A``/``B``/``C`` reference band 1; ``A1``, ``A2``, ... address each band.
        namespace[letter] = bands[0]
        for i, arr in enumerate(bands, start=1):
            namespace[f"{letter}{i}"] = arr
        return profile, shape, crs, transform

    namespace = {}
    profile, base_shape, base_crs, base_transform = load_bands(input_path, "A", namespace, None)
    for letter, path in (("B", b_path), ("C", c_path)):
        if path:
            load_bands(path, letter, namespace, (base_shape, base_crs, base_transform))
        # An expression that references B/C without a supplied path would otherwise
        # fail deep in eval with an opaque "name 'B' is not defined". Catch the
        # common case up front. The word-boundary match avoids false positives from
        # function names that merely contain the letter (e.g. 'abs' has no bare 'B').
        elif re.search(rf"(?<![A-Za-z0-9_]){letter}[0-9]*(?![A-Za-z0-9_])", expression):
            raise SystemExit(
                f"Expression references '{letter}' but no Raster {letter} path was provided."
            )

    # Evaluate the expression in a restricted namespace: no builtins, only the band
    # arrays and a curated set of NumPy functions. The sidecar is local and confined
    # to the conversion roots, but stripping ``__builtins__`` still blocks arbitrary
    # attribute/import access from a hand-typed expression. The bare ``np`` module is
    # intentionally NOT exposed: it would re-open file I/O (np.load/fromfile/savetxt)
    # that bypasses the path allowlist. Every function band math needs is listed here.
    safe_funcs = {
        "where": np.where,
        "log": np.log,
        "log10": np.log10,
        "exp": np.exp,
        "sqrt": np.sqrt,
        "abs": np.abs,
        "sin": np.sin,
        "cos": np.cos,
        "tan": np.tan,
        "arctan": np.arctan,
        "minimum": np.minimum,
        "maximum": np.maximum,
        "clip": np.clip,
        "floor": np.floor,
        "ceil": np.ceil,
        "round": np.round,
        "pi": np.pi,
        "e": np.e,
    }
    namespace.update(safe_funcs)
    # Band arrays are full ndarrays, so attribute access (``A.tofile(...)``,
    # ``A.dump(...)``) would still write files even with an empty ``__builtins__``
    # and no bare ``np``. Allowlist the expression AST before ``eval`` so only
    # curated calls/operators run — and so list/bytes/tuple multiplication cannot
    # allocate unbounded memory before the shape check.
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        raise SystemExit(f"Failed to evaluate expression: {exc}") from exc
    allowed_calls = set(safe_funcs)
    _allowed_nodes = (
        ast.Expression,
        ast.Name,
        ast.Load,
        ast.Constant,
        ast.Call,
        ast.BinOp,
        ast.UnaryOp,
        ast.BoolOp,
        ast.Compare,
        ast.IfExp,
        ast.Add,
        ast.Sub,
        ast.Mult,
        ast.Div,
        ast.FloorDiv,
        ast.Mod,
        ast.Pow,
        ast.UAdd,
        ast.USub,
        ast.Not,
        ast.And,
        ast.Or,
        ast.Eq,
        ast.NotEq,
        ast.Lt,
        ast.LtE,
        ast.Gt,
        ast.GtE,
        ast.keyword,
    )
    # ``**`` on two plain integers stays exact, so ``9**9**6`` builds a
    # half-million-digit result and pins a core for tens of seconds before the shape
    # check can reject it. Require the exponent to be a small numeric literal unless
    # it derives from a band or a curated call, whose element-wise float power is
    # bounded by the raster's shape. 64 is far past anything band math needs
    # (squares, gamma, roots).
    MAX_POW_EXPONENT = 64
    for node in ast.walk(tree):
        if not isinstance(node, _allowed_nodes):
            raise SystemExit(
                f"Expression may not use {type(node).__name__} "
                "(band math only allows curated functions and operators)"
            )
        if isinstance(node, ast.Constant) and not isinstance(node.value, (int, float, bool)):
            raise SystemExit(
                "Expression may only use numeric constants "
                "(band math only allows curated functions and operators)"
            )
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Pow):
            exponent = node.right
            while isinstance(exponent, ast.UnaryOp):
                exponent = exponent.operand
            band_backed = any(
                isinstance(inner, (ast.Name, ast.Call)) for inner in ast.walk(exponent)
            )
            if not band_backed:
                if not isinstance(exponent, ast.Constant):
                    raise SystemExit(
                        "Exponent must be a plain number or derive from a band "
                        f"(band math caps '**' at {MAX_POW_EXPONENT})"
                    )
                if abs(exponent.value) > MAX_POW_EXPONENT:
                    raise SystemExit(
                        f"Exponent may not exceed {MAX_POW_EXPONENT} "
                        "(band math caps '**' to keep evaluation bounded)"
                    )
                left_band_backed = any(
                    isinstance(inner, (ast.Name, ast.Call)) for inner in ast.walk(node.left)
                )
                if not left_band_backed and any(
                    isinstance(inner, ast.Pow) for inner in ast.walk(node.left)
                ):
                    raise SystemExit(
                        "Nested constant exponentiation is not allowed "
                        "(band math caps '**' to keep evaluation bounded)"
                    )
        if isinstance(node, ast.Call):
            # ``np.where(...)`` / ``A.tofile(...)`` parse as Attribute-backed calls;
            # Attribute is already rejected above, but keep an explicit Name check.
            if not isinstance(node.func, ast.Name) or node.func.id not in allowed_calls:
                name = node.func.id if isinstance(node.func, ast.Name) else type(node.func).__name__
                raise SystemExit(f"Call to '{name}' is not allowed in band math")

    # Convert integer literals (excluding bools and the integer `decimals` argument
    # of `round(...)`) to float so arbitrary-precision integer chains cannot exhaust
    # CPU or memory while keeping `np.round(A, 2)` / `np.round(A, decimals=2)` valid.
    def _is_int_literal(expr):
        if isinstance(expr, ast.UnaryOp) and isinstance(expr.op, (ast.UAdd, ast.USub)):
            expr = expr.operand
        return (
            isinstance(expr, ast.Constant)
            and isinstance(expr.value, int)
            and not isinstance(expr.value, bool)
        )

    class _IntToFloat(ast.NodeTransformer):
        def visit_Call(self, node):
            is_round = isinstance(node.func, ast.Name) and node.func.id == "round"
            new_args = []
            for idx, arg in enumerate(node.args):
                if is_round and idx == 1 and _is_int_literal(arg):
                    new_args.append(arg)
                else:
                    new_args.append(self.visit(arg))
            node.args = new_args
            new_keywords = []
            for kw in node.keywords:
                if is_round and kw.arg == "decimals" and _is_int_literal(kw.value):
                    new_keywords.append(kw)
                else:
                    kw.value = self.visit(kw.value)
                    new_keywords.append(kw)
            node.keywords = new_keywords
            return node

        def visit_Constant(self, node):
            if isinstance(node.value, int) and not isinstance(node.value, bool):
                try:
                    converted = float(node.value)
                except OverflowError as exc:
                    raise SystemExit("Numeric literal is too large for band math") from exc
                return ast.copy_location(ast.Constant(value=converted), node)
            return node

    try:
        tree = ast.fix_missing_locations(_IntToFloat().visit(tree))
        with np.errstate(all="ignore"):
            result = eval(compile(tree, "<band_math>", "eval"), {"__builtins__": {}}, namespace)
    except SystemExit:
        raise
    except Exception as exc:
        # A bare `A<n>` reference past the input's band count surfaces as an opaque
        # NameError; hint at the real cause (e.g. a spectral index whose band layout
        # exceeds the raster) instead of the raw "name 'A4' is not defined".
        band_ref = re.search(r"name '(A\d+)' is not defined", str(exc))
        if band_ref:
            raise SystemExit(
                f"Expression references band {band_ref.group(1)}, which the input "
                "raster does not have. Check the band layout / sensor preset."
            )
        raise SystemExit(f"Failed to evaluate expression: {exc}")

    result = np.asarray(result, dtype="float64")
    if result.shape != base_shape:
        # A scalar or single-band broadcast result is fine; anything else is a
        # dimension mismatch the user must fix.
        try:
            result = np.broadcast_to(result, base_shape).astype("float64")
        except ValueError:
            raise SystemExit(f"Expression produced a {result.shape} array; expected {base_shape}.")

    out = np.where(np.isfinite(result), result, nodata).astype("float32")
    profile.update(count=1, dtype="float32", nodata=nodata, compress="deflate")
    # Drop multiband photometric hints carried over from a multiband input A.
    profile.pop("photometric", None)
    with rasterio.open(output_path, "w", **profile) as dst:
        dst.write(out, 1)
    print(f"Evaluated '{expression}' -> {output_path}")
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"output_path": output_path}))


if __name__ == "__main__":
    main()
