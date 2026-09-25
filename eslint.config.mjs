// ESLint flat config.
//
// Errors are reserved for bugs `tsc` cannot see: a misplaced Hook (e.g. a
// `useMemo` after an early `return`) type-checks but crashes the app at
// runtime with "Rendered more hooks than during the previous render", and
// `react-hooks/rules-of-hooks` catches exactly that class of bug statically.
//
// Everything else is a warning held by a ratchet: `npm run lint` passes
// `--max-warnings` set to today's count, so the number can only go down. When
// you fix warnings, lower the limit in package.json to the new count in the
// same PR (the lint output prints it). Never raise it to make a PR pass; fix
// the new warning or disable it on that line with a reason.
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import local from "./eslint-rules/no-physical-tailwind.mjs";

// Source compiled into the app, the packages and the workers. Type-aware rules
// run only here: each file is checked against the tsconfig.json nearest to it
// (typescript-eslint's project service), and scripts/tests/configs outside a
// tsconfig are left to the syntactic rules.
const TYPED_SOURCES = [
  "apps/geolibre-desktop/src/**/*.{ts,tsx}",
  "packages/*/src/**/*.{ts,tsx}",
  "workers/*/src/**/*.ts",
];

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
      "**/public/plugins/**",
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
    // The full @typescript-eslint plugin is registered so that existing
    // `// eslint-disable @typescript-eslint/*` comments resolve to a known
    // rule instead of erroring as "rule definition not found".
    plugins: {
      "react-hooks": reactHooks,
      "@typescript-eslint": tseslint.plugin,
      local,
    },
    // Only a handful of rules are on, so existing disable directives that
    // anticipate a fuller ruleset would otherwise be reported as unused.
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Accessibility: an icon-only control needs an accessible name, and a
    // click handler on a plain element needs a role and keyboard support.
    // eslint-plugin-jsx-a11y 6.10 declares ESLint <= 9 as a peer; it runs
    // under ESLint 10, and the root package.json `overrides` entry points its
    // peer at the installed ESLint.
    files: ["apps/**/*.{tsx,jsx}", "packages/**/*.{tsx,jsx}"],
    plugins: { "jsx-a11y": jsxA11y },
    rules: {
      // Form fields are labelled by a wrapping <label> or `htmlFor`, which this
      // rule cannot see, so they are ignored here (the plugin's recommended
      // ignoreElements); it targets unlabelled buttons, links and ARIA controls.
      "jsx-a11y/control-has-associated-label": [
        "warn",
        {
          ignoreElements: ["audio", "canvas", "embed", "input", "textarea", "tr", "video"],
          ignoreRoles: [
            "grid",
            "listbox",
            "menu",
            "menubar",
            "radiogroup",
            "row",
            "tablist",
            "toolbar",
            "tree",
            "treegrid",
          ],
          includeRoles: ["alert", "dialog"],
          depth: 7,
        },
      ],
      "jsx-a11y/no-static-element-interactions": "warn",
    },
  },
  {
    // The UI mirrors for right-to-left locales; see docs/i18n.md.
    files: ["apps/**/*.{ts,tsx,jsx}", "packages/**/*.{ts,tsx,jsx}"],
    rules: {
      "local/no-physical-tailwind": "warn",
    },
  },
  {
    files: TYPED_SOURCES,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A promise nobody awaits or catches turns a rejection into an
      // unhandled one: the failure never reaches the user or the diagnostics
      // log. Mark a deliberate fire-and-forget with `void`.
      "@typescript-eslint/no-floating-promises": "warn",
    },
  },
];
