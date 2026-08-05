/**
 * Registers the maplibre default-import load hook for `node --test`.
 * Used via `node --import ./tests/hooks/register-maplibre-shim.mjs`, alongside
 * tsx's own hooks — the two do not overlap (this one only rewrites published
 * bundles under node_modules).
 */
import { register } from "node:module";

register("./maplibre-default-import-shim.mjs", import.meta.url);
