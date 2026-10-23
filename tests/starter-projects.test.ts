import assert from "node:assert/strict";
import { describe, it } from "node:test";
import manifest from "../apps/geolibre-desktop/src/lib/starter-projects.json";
import {
  parseStarterManifest,
  STARTER_PROJECTS,
  validateStarterManifest,
} from "../apps/geolibre-desktop/src/lib/starter-projects";

const valid = {
  id: "demo",
  title: "Demo",
  description: "A demo map",
  thumbnailUrl: "https://example.com/demo.webp",
  projectUrl: "https://example.com/demo.geolibre.json",
};

describe("bundled starter-project manifest", () => {
  it("validates cleanly", () => {
    assert.deepEqual(validateStarterManifest(manifest), []);
  });

  it("stays small (6-10 examples) and loses no entry when parsed", () => {
    assert.ok(manifest.examples.length >= 6 && manifest.examples.length <= 10);
    assert.equal(STARTER_PROJECTS.length, manifest.examples.length);
  });

  it("uses https URLs for every thumbnail and project", () => {
    for (const example of STARTER_PROJECTS) {
      assert.equal(new URL(example.thumbnailUrl).protocol, "https:", example.id);
      assert.equal(new URL(example.projectUrl).protocol, "https:", example.id);
    }
  });
});

describe("validateStarterManifest", () => {
  it("rejects a manifest without an examples array", () => {
    assert.equal(validateStarterManifest({}).length, 1);
    assert.equal(validateStarterManifest(null).length, 1);
  });

  it("reports missing or empty fields", () => {
    const { title: _title, ...noTitle } = valid;
    const problems = validateStarterManifest({
      examples: [noTitle, { ...valid, id: "b", description: " " }],
    });
    assert.deepEqual(problems, [
      "examples[0].title is missing or empty",
      "examples[1].description is missing or empty",
    ]);
  });

  it("requires https URLs and a .geolibre.json project", () => {
    const problems = validateStarterManifest({
      examples: [
        { ...valid, thumbnailUrl: "http://example.com/a.webp" },
        { ...valid, id: "b", projectUrl: "https://example.com/b.json" },
        { ...valid, id: "c", projectUrl: "not a url.geolibre.json" },
      ],
    });
    assert.deepEqual(problems, [
      "examples[0].thumbnailUrl is not an https URL",
      "examples[1].projectUrl is not a .geolibre.json file",
      "examples[2].projectUrl is not an https URL",
    ]);
  });

  it("flags duplicate ids and non-object entries", () => {
    assert.deepEqual(validateStarterManifest({ examples: [valid, valid, 3] }), [
      'examples[1].id "demo" is duplicated',
      "examples[2] is not an object",
    ]);
  });
});

describe("parseStarterManifest", () => {
  it("drops invalid entries but keeps the valid ones", () => {
    const parsed = parseStarterManifest({
      examples: [valid, { ...valid, id: "bad", projectUrl: "ftp://x/y.geolibre.json" }],
    });
    assert.deepEqual(
      parsed.map((p) => p.id),
      ["demo"],
    );
    assert.deepEqual(parseStarterManifest("nope"), []);
  });

  it("keeps only the first entry for a repeated id", () => {
    const parsed = parseStarterManifest({
      examples: [valid, { ...valid, title: "Copy" }, { ...valid, id: "other" }],
    });
    assert.deepEqual(
      parsed.map((p) => [p.id, p.title]),
      [
        ["demo", "Demo"],
        ["other", "Demo"],
      ],
    );
  });
});
