import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUILTIN_SERVICES,
  createServiceEntry,
  listServices,
  mergeImportedServices,
  normalizeServiceEntries,
  parseImportedServices,
  removeServiceEntry,
  serializeUserServices,
  serviceCategories,
  serviceFieldBoolean,
  serviceFieldString,
  type ServiceLibraryEntry,
  upsertServiceEntry,
} from "../apps/geolibre-desktop/src/components/layout/add-data/service-library";

function makeEntry(
  overrides: Partial<ServiceLibraryEntry> = {},
): ServiceLibraryEntry {
  return {
    id: overrides.id ?? "id-1",
    name: overrides.name ?? "Example WMS",
    category: overrides.category ?? "Imagery",
    kind: overrides.kind ?? "wms",
    fields: overrides.fields ?? { endpoint: "https://x.test/wms" },
  };
}

describe("service field accessors", () => {
  it("coerces string/number/boolean and falls back when absent", () => {
    const fields = { a: "x", b: 256, c: true };
    assert.equal(serviceFieldString(fields, "a"), "x");
    assert.equal(serviceFieldString(fields, "b"), "256");
    assert.equal(serviceFieldString(fields, "c"), "true");
    assert.equal(serviceFieldString(fields, "missing", "fallback"), "fallback");
    assert.equal(serviceFieldBoolean(fields, "c"), true);
    assert.equal(serviceFieldBoolean(fields, "a", true), true);
  });
});

describe("normalizeServiceEntries", () => {
  it("keeps valid entries and drops invalid ones", () => {
    const entries = normalizeServiceEntries([
      makeEntry(),
      { kind: "wms", name: "", fields: { a: "b" } }, // empty name
      { kind: "bogus", name: "Nope", fields: { a: "b" } }, // bad kind
      { kind: "wfs", name: "No fields", fields: {} }, // no usable fields
      "not an object",
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "Example WMS");
  });

  it("re-ids duplicate ids so each entry stays unique", () => {
    const entries = normalizeServiceEntries([
      makeEntry({ id: "dup" }),
      makeEntry({ id: "dup", name: "Second" }),
    ]);
    assert.equal(entries.length, 2);
    assert.notEqual(entries[0].id, entries[1].id);
  });

  it("strips a non-string field and an injected builtin flag", () => {
    const [entry] = normalizeServiceEntries([
      {
        ...makeEntry(),
        builtin: true,
        fields: { endpoint: "https://x.test", bad: { nested: 1 } },
      },
    ]);
    assert.equal(entry.builtin, undefined);
    assert.deepEqual(entry.fields, { endpoint: "https://x.test" });
  });

  it("re-ids an entry whose id collides with a built-in id", () => {
    const builtinId = BUILTIN_SERVICES[0].id;
    const [entry] = normalizeServiceEntries([makeEntry({ id: builtinId })]);
    assert.notEqual(entry.id, builtinId);
  });

  it("returns an empty list for non-array input", () => {
    assert.deepEqual(normalizeServiceEntries({ services: [] }), []);
    assert.deepEqual(normalizeServiceEntries(null), []);
  });
});

describe("createServiceEntry", () => {
  it("reuses a provided id (update in place) or mints a new one", () => {
    const updated = createServiceEntry({
      id: "keep-me",
      name: "Updated",
      category: "Imagery",
      kind: "wms",
      fields: { endpoint: "https://x.test" },
    });
    assert.equal(updated.id, "keep-me");
    const fresh = createServiceEntry({
      name: "Fresh",
      category: "",
      kind: "wms",
      fields: { endpoint: "https://x.test" },
    });
    assert.ok(fresh.id && fresh.id !== "keep-me");
  });
});

describe("upsert / remove", () => {
  it("prepends a new entry and replaces by id", () => {
    const a = makeEntry({ id: "a", name: "A" });
    const b = makeEntry({ id: "b", name: "B" });
    let list = upsertServiceEntry([a], b);
    assert.deepEqual(
      list.map((e) => e.id),
      ["b", "a"],
    );
    list = upsertServiceEntry(list, makeEntry({ id: "a", name: "A2" }));
    assert.equal(list.length, 2);
    assert.equal(list.find((e) => e.id === "a")?.name, "A2");
  });

  it("removes by id", () => {
    const list = removeServiceEntry([makeEntry({ id: "a" })], "a");
    assert.deepEqual(list, []);
  });
});

describe("listServices", () => {
  it("lists built-ins first, then user entries of that kind", () => {
    const user = makeEntry({ id: "u1", kind: "wms", name: "My WMS" });
    const wms = listServices("wms", [user]);
    const builtinWms = BUILTIN_SERVICES.filter((e) => e.kind === "wms");
    assert.equal(wms.length, builtinWms.length + 1);
    assert.ok(wms[0].builtin);
    assert.equal(wms[wms.length - 1].name, "My WMS");
    // A user XYZ entry must not appear under the wms kind.
    assert.equal(
      listServices("wms", [makeEntry({ kind: "xyz", id: "x" })]).some(
        (e) => e.id === "x",
      ),
      false,
    );
  });
});

describe("serviceCategories", () => {
  it("returns distinct, sorted, non-empty categories", () => {
    const cats = serviceCategories([
      makeEntry({ id: "1", category: "Theme" }),
      makeEntry({ id: "2", category: "Country" }),
      makeEntry({ id: "3", category: "Theme" }),
      makeEntry({ id: "4", category: "" }),
    ]);
    assert.deepEqual(cats, ["Country", "Theme"]);
  });
});

describe("import / export round-trip", () => {
  it("serializes user entries (without builtin flag) and re-parses them", () => {
    const entry = createServiceEntry({
      name: "Round trip",
      category: "Demo",
      kind: "wfs",
      fields: { endpoint: "https://x.test/wfs", maxFeatures: "10" },
    });
    const json = serializeUserServices([entry]);
    assert.ok(!json.includes("builtin"));
    const parsed = parseImportedServices(json);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, "Round trip");
    assert.deepEqual(parsed[0].fields, entry.fields);
  });

  it("accepts a bare entry array as well as the wrapped format", () => {
    const parsed = parseImportedServices(JSON.stringify([makeEntry()]));
    assert.equal(parsed.length, 1);
  });

  it("throws on invalid JSON", () => {
    assert.throws(() => parseImportedServices("{not json"));
  });

  it("merges imported entries and re-ids collisions", () => {
    const existing = [makeEntry({ id: "shared", name: "Existing" })];
    const imported = [makeEntry({ id: "shared", name: "Imported" })];
    const merged = mergeImportedServices(existing, imported);
    assert.equal(merged.length, 2);
    assert.equal(new Set(merged.map((e) => e.id)).size, 2);
    assert.deepEqual(
      merged.map((e) => e.name),
      ["Existing", "Imported"],
    );
  });

  it("re-ids an imported entry that collides with a built-in id", () => {
    const builtinId = BUILTIN_SERVICES[0].id;
    const imported = [makeEntry({ id: builtinId, name: "Imported" })];
    const merged = mergeImportedServices([], imported);
    assert.equal(merged.length, 1);
    assert.notEqual(merged[0].id, builtinId);
  });
});
