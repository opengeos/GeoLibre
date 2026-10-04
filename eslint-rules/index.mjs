// The repo's local ESLint plugin, registered as `local` in eslint.config.mjs.
import noCrossEngineImports from "./no-cross-engine-imports.mjs";
import noPhysicalTailwind from "./no-physical-tailwind.mjs";
import noRendererKindChecks from "./no-renderer-kind-checks.mjs";

/** @type {import("eslint").ESLint.Plugin} */
export default {
  meta: { name: "geolibre-local" },
  rules: {
    ...noPhysicalTailwind.rules,
    "no-cross-engine-imports": noCrossEngineImports,
    "no-renderer-kind-checks": noRendererKindChecks,
  },
};
