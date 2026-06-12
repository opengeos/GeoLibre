// Minimal ESLint flat config.
//
// Scope is intentionally narrow: it enforces the React Hooks rules and nothing
// else. A misplaced Hook (e.g. a `useMemo` after an early `return`) is invisible
// to `tsc` but crashes the app at runtime with "Rendered more hooks than during
// the previous render". `react-hooks/rules-of-hooks` catches exactly that class
// of bug statically. We deliberately do not enable the broader recommended
// rulesets here to avoid a large, churny cleanup across the existing codebase;
// that can be layered on later.
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/dist-embed/**",
      "**/build/**",
      "**/target/**",
      "**/node_modules/**",
      // Generated/vendored bundles (the embedded web app baked into the Python
      // wheel, the built docs site, minified assets) must never be parsed.
      "python/**",
      "site/**",
      "**/static/**",
      "**/*.min.js",
      "**/*.d.ts",
    ],
  },
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    // The @typescript-eslint plugin is registered (but its rules stay off) so
    // that existing `// eslint-disable @typescript-eslint/*` comments resolve to
    // a known rule instead of erroring as "rule definition not found".
    plugins: {
      "react-hooks": reactHooks,
      "@typescript-eslint": tseslint.plugin,
    },
    // This config deliberately enables only the React Hooks rules, so existing
    // disable directives that anticipate a fuller ruleset would otherwise be
    // reported as unused. Don't flag them here.
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
