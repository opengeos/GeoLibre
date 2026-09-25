import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import local, { findPhysicalClasses } from "../eslint-rules/no-physical-tailwind.mjs";

function tokens(text: string): string[] {
  return findPhysicalClasses(text).map((hit: { token: string }) => hit.token);
}

function lint(code: string): string[] {
  const linter = new Linter({ configType: "flat" });
  const messages = linter.verify(
    code,
    [
      {
        files: ["**/*.tsx"],
        languageOptions: {
          parser: tseslint.parser as Linter.Parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { local },
        rules: { "local/no-physical-tailwind": "warn" },
      },
    ],
    "fixture.tsx",
  );
  return messages.map((m) => m.message);
}

describe("findPhysicalClasses", () => {
  it("flags physical margins, paddings, insets and text alignment", () => {
    assert.deepEqual(tokens("ml-2 pr-4 left-3 right-0 text-left text-right"), [
      "ml-2",
      "pr-4",
      "left-3",
      "right-0",
      "text-left",
      "text-right",
    ]);
  });

  it("suggests the logical utility", () => {
    assert.deepEqual(
      findPhysicalClasses("-ml-1 md:pr-2 text-right").map(
        (hit: { suggestion: string }) => hit.suggestion,
      ),
      ["ms-1", "pe-2", "text-end"],
    );
  });

  it("sees through variants, negatives and the important marker", () => {
    assert.deepEqual(tokens("hover:ml-2 -left-1 !pr-3 sm:hover:right-4"), [
      "hover:ml-2",
      "-left-1",
      "!pr-3",
      "sm:hover:right-4",
    ]);
  });

  it("allows symmetric centering and matched opposite sides", () => {
    assert.deepEqual(tokens("left-1/2 -translate-x-1/2 left-[50%]"), []);
    assert.deepEqual(tokens("absolute left-0 right-0 pl-2 pr-2"), []);
    // A pair only cancels under the same variant.
    assert.deepEqual(tokens("md:left-0 right-0"), ["md:left-0", "right-0"]);
  });

  it("leaves logical utilities and look-alikes alone", () => {
    assert.deepEqual(tokens("ms-2 pe-4 start-0 end-0 text-start border-l mlx-2 leftover"), []);
  });
});

describe("local/no-physical-tailwind", () => {
  it("checks className strings, templates and conditionals", () => {
    const messages = lint(
      "const a = <div className={`p-2 ${open ? 'ml-2' : 'ms-2'} left-3`} />;\n" +
        'const b = <div className="text-right" />;',
    );
    assert.equal(messages.length, 3);
  });

  it("checks class-helper calls outside JSX and reports each string once", () => {
    const messages = lint(
      "const c = cn('pl-2', { 'mr-1': x }, cond && 'right-2');\n" +
        "const d = <div className={cn('ml-4')} />;",
    );
    assert.equal(messages.length, 4);
  });

  it("ignores strings that never reach a class list", () => {
    assert.deepEqual(lint("const e = t('panel.left-3'); const f = 'ml-2';"), []);
  });
});
