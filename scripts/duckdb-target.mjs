// Shared parser for the build target triple so the tauri-build wrapper and the
// DuckDB fetch helper agree on the flag forms. `tauri build` accepts the split
// (`--target <triple>`, `-t <triple>`) and joined (`--target=<triple>`,
// `-t=<triple>`) forms, so a single source of truth keeps them from drifting.
export function parseTargetTripleArg(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--target" || arg === "-t") return args[i + 1] ?? "";
    if (arg.startsWith("--target=")) return arg.slice("--target=".length);
    if (arg.startsWith("-t=")) return arg.slice("-t=".length);
  }
  return "";
}
