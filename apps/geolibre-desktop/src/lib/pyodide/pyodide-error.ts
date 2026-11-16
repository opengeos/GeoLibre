/**
 * The user-facing message of a Pyodide `PythonError`.
 *
 * A `PythonError`'s `message` is the whole formatted traceback: the
 * `Traceback (most recent call last):` header, a frame for every call through
 * Pyodide's own `_pyodide/_base.py` and `vector_ops.py`, and only then the
 * exception itself. Shown as is, the one line the user needs (say, that the
 * layer spans more than 180° of longitude) sits at the bottom of a stack dump
 * (GeoLibre#3469). This keeps just the final exception.
 *
 * A `ValueError` is how `vector_ops` reports bad input, and the sidecar shows
 * those as `str(exc)` (`app/vector.py`), so its type prefix is dropped to match;
 * any other exception keeps its type, which is the useful part of an
 * unexpected failure. Text that is not a traceback is returned unchanged.
 *
 * @param message - The error message the Pyodide worker posted.
 * @returns The message to show.
 */
export function pythonErrorMessage(message: string): string {
  const lines = message.replace(/\s+$/, "").split(/\r?\n/);
  let header = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("Traceback (most recent call last):")) {
      header = i;
      break;
    }
  }
  if (header === -1) return message;
  // The frames are indented; the exception starts at the first line after the
  // header that is not, and may run over several lines.
  let start = -1;
  for (let i = header + 1; i < lines.length; i++) {
    if (lines[i] !== "" && !/^\s/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return message;
  const exception = lines.slice(start).join("\n").trim();
  const stripped = exception.replace(/^ValueError: /, "");
  return stripped || message;
}
