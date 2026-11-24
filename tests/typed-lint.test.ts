import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { runTypedLint, typedDiagnostics, typedSourceRoots } from "../scripts/lint-typed.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = mkdtempSync(path.join(tmpdir(), "geolibre-typed-lint-"));
const source = path.join(fixture, "apps/geolibre-desktop/src");
mkdirSync(source, { recursive: true });
for (const directory of ["packages", "workers", "apps/geolibre-desktop/src-tauri/vendor"])
  mkdirSync(path.join(fixture, directory), { recursive: true });
symlinkSync(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "junction");
copyFileSync(path.join(root, ".oxlintrc.json"), path.join(fixture, ".oxlintrc.json"));
writeFileSync(
  path.join(fixture, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
    },
    include: ["apps/geolibre-desktop/src/*.ts"],
  }),
);
writeFileSync(
  path.join(source, "api.ts"),
  "export async function run(): Promise<number> { return 1; }\n",
);
// The old typed rule never visited vendored native projects.
writeFileSync(
  path.join(fixture, "apps/geolibre-desktop/src-tauri/vendor/tsconfig.json"),
  '{"extends":"./missing.json"}',
);
after(() => rmSync(fixture, { recursive: true, force: true }));

describe("typed lint production gate", () => {
  it("checks cross-file promise types, scope, and each accepted handler", () => {
    writeFileSync(
      path.join(source, "sample.ts"),
      `import { run } from './api';
run();
void run();
run().catch(() => {});
run().then(() => {}, () => {});
[run(), run()];
const alias = run;
alias();
await run();
// Café 😀
// eslint-disable-next-line local/no-physical-tailwind -- belongs to the syntax pass
void run();
// oxlint-disable-next-line typescript/no-floating-promises -- intentional
run();
`,
    );
    const report = runTypedLint({ cwd: fixture, maxWarnings: 3 });
    assert.equal(report.ok, true);
    assert.equal(report.errors, 0);
    assert.equal(report.warnings, 3);
    assert.deepEqual(
      report.diagnostics
        .map((item: { labels: { span: { line: number } }[] }) => item.labels[0].span.line)
        .sort((a: number, b: number) => a - b),
      [2, 6, 8],
    );
    assert.equal(runTypedLint({ cwd: fixture, maxWarnings: 2 }).ok, false);
    assert.deepEqual(typedSourceRoots(fixture), ["apps/geolibre-desktop/src"]);
  });

  it("checks package and worker source projects too", () => {
    const projects = ["packages/example", "workers/example"];
    try {
      for (const project of projects) {
        const directory = path.join(fixture, project);
        mkdirSync(path.join(directory, "src"), { recursive: true });
        writeFileSync(
          path.join(directory, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: { target: "ES2022", module: "ESNext", strict: true },
            include: ["src/**/*.ts"],
          }),
        );
        writeFileSync(
          path.join(directory, "src/sample.ts"),
          "export async function run() { return 1; }\nrun();\n",
        );
      }
      const report = runTypedLint({ cwd: fixture, maxWarnings: 5 });
      assert.equal(report.ok, true);
      assert.equal(report.warnings, 5);
      for (const project of projects)
        assert.equal(
          report.diagnostics.filter((item: { filename: string }) =>
            item.filename.startsWith(path.join(fixture, project)),
          ).length,
          1,
        );
      assert.deepEqual(typedSourceRoots(fixture), [
        "apps/geolibre-desktop/src",
        "packages/example/src",
        "workers/example/src",
      ]);
    } finally {
      for (const project of projects)
        rmSync(path.join(fixture, project), { recursive: true, force: true });
    }
  });

  it("rejects stale typed suppressions regardless of the warning budget", () => {
    writeFileSync(
      path.join(source, "sample.ts"),
      `import { run } from './api';
// oxlint-disable-next-line typescript/no-floating-promises -- now stale
void run();
`,
    );
    const report = runTypedLint({ cwd: fixture, maxWarnings: 100 });
    assert.equal(report.ok, false);
    assert.equal(report.errors, 1);
    assert.match(report.diagnostics[0].message, /Unused/);
  });

  it("keeps syntax-pass suppression errors enabled", async () => {
    const eslint = new ESLint({ cwd: root });
    const [report] = await eslint.lintText(
      "// eslint-disable-next-line @typescript-eslint/no-floating-promises -- stale\nvoid Promise.resolve();\n",
      { filePath: "apps/geolibre-desktop/src/lint-fixture.ts" },
    );
    assert.equal(report.errorCount, 1);
    assert.match(report.messages[0].message, /Unused eslint-disable/);
  });

  it("fails closed on an invalid compiler configuration", () => {
    writeFileSync(path.join(source, "tsconfig.json"), '{"extends":"./missing.json"}');
    assert.throws(() => runTypedLint({ cwd: fixture }), /Invalid tsconfig|Cannot read file/);
  });

  it("does not discard unrelated errors or unreadable diagnostics", () => {
    const diagnostics = [
      { code: "typescript(tsconfig-error)", message: "Invalid tsconfig", severity: "error" },
      { message: "Unused eslint-disable directive", severity: "warning", labels: [] },
    ];
    assert.deepEqual(typedDiagnostics(diagnostics), diagnostics);
  });
});
