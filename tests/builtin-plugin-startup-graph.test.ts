import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

// Check the actual authoring entrypoints, including UI and restore hooks, rather
// than only the metadata catalog. A helper import can otherwise bypass its loader.
test("the authoring static graph does not evaluate built-in plugin wrappers or the SDK barrel", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const configPath = path.join(root, "apps/geolibre-desktop/tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(configPath),
  );
  const catalogPath = path.join(root, "packages/plugins/src/builtin-plugins.ts");
  const catalog = readFileSync(catalogPath, "utf8");
  const wrappers = new Set(
    [...catalog.matchAll(/import\("(\.\/plugins\/[^"]+)"\)/g)].map(
      (match) =>
        ts.resolveModuleName(match[1]!, catalogPath, options, ts.sys).resolvedModule
          ?.resolvedFileName,
    ),
  );
  assert.ok(wrappers.size >= 68, "discover all catalog implementation modules");
  const pending = ["main.tsx", "App.tsx", "hooks/usePlugins.ts"].map((entry) =>
    path.join(root, "apps/geolibre-desktop/src", entry),
  );
  const visited = new Set<string>();
  const parent = new Map<string, string>();
  const chain = (file: string): string => {
    const trace = [path.relative(root, file)];
    const seen = new Set([file]);
    while (parent.has(file)) {
      file = parent.get(file)!;
      if (seen.has(file)) break;
      seen.add(file);
      trace.push(path.relative(root, file));
    }
    return trace.join(" <- ");
  };
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    assert.equal(wrappers.has(file), false, chain(file));
    assert.notEqual(file, path.join(root, "packages/plugins/src/index.ts"), chain(file));
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
      if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.length &&
        statement.exportClause.elements.every((entry) => entry.isTypeOnly)
      )
        continue;
      if (ts.isImportDeclaration(statement)) {
        if (statement.importClause?.isTypeOnly) continue;
        const bindings = statement.importClause?.namedBindings;
        if (
          !statement.importClause?.name &&
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length &&
          bindings.elements.every((entry) => entry.isTypeOnly)
        )
          continue;
      }
      const resolved = ts.resolveModuleName(statement.moduleSpecifier.text, file, options, ts.sys)
        .resolvedModule?.resolvedFileName;
      if (!resolved || !resolved.startsWith(root) || resolved.includes("/node_modules/")) continue;
      if (!parent.has(resolved)) parent.set(resolved, file);
      pending.push(resolved);
    }
  }
  assert.ok(visited.size > 1000, "walk the full authoring source graph");
});
