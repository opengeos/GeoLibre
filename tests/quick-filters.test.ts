import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { featureFilter } from "@maplibre/maplibre-gl-style-spec";
import {
  activeQuickFilters,
  clearQuickFilterValues,
  compileQuickFilter,
  compileQuickFilters,
  hasActiveQuickFilter,
  type GeoLibreLayer,
  type LayerQuickFilter,
} from "@geolibre/core";
import {
  createQuickFilterScan,
  profileQuickFilterFields,
  type QuickFilterFieldProfile,
  QUICK_FILTER_PROFILE_LIMIT,
} from "../apps/geolibre-desktop/src/lib/quick-filter-profile";
import {
  ensureQuickFilterProfiles,
  hasQuickFilterProfiles,
  readQuickFilterProfileCache,
} from "../apps/geolibre-desktop/src/lib/quick-filter-profile-cache";

/**
 * Run a compiled quick filter through MapLibre's own filter evaluator, so the
 * tests assert on rendered behavior rather than on expression shape. A filter
 * that MapLibre rejects throws here, which is the point: the whole feature
 * rests on the compiled output being a valid filter.
 */
function keptRows(
  filters: LayerQuickFilter[],
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const compiled = compileQuickFilters(filters);
  if (!compiled) return rows;
  const compiledFilter = featureFilter(compiled as never, "layers[0].filter");
  assert.equal(
    typeof compiledFilter.filter,
    "function",
    "maplibre-gl-style-spec rejected the compiled quick filter",
  );
  return rows.filter((properties) =>
    compiledFilter.filter({ zoom: 0 }, { type: 1, properties } as never, undefined as never),
  );
}

function layerWith(quickFilters: LayerQuickFilter[] | undefined): GeoLibreLayer {
  return { quickFilters } as GeoLibreLayer;
}

const CITIES = [
  {
    name: "Portland",
    state: "OR",
    pop: 650_000,
    founded: "1845-02-08",
    code: 1,
  },
  { name: "Salem", state: "OR", pop: 175_000, founded: "1842-01-12", code: 1 },
  {
    name: "Seattle",
    state: "WA",
    pop: 750_000,
    founded: "1869-12-02",
    code: 2,
  },
  { name: "Boise", state: "ID", pop: 235_000, founded: "1863-07-07", code: 3 },
];

describe("compileQuickFilter", () => {
  it("returns null for a control nobody has answered yet", () => {
    assert.equal(compileQuickFilter({ id: "a", field: "state", kind: "categorical" }), null);
    assert.equal(compileQuickFilter({ id: "a", field: "pop", kind: "range" }), null);
    assert.equal(compileQuickFilter({ id: "a", field: "founded", kind: "date" }), null);
    assert.equal(compileQuickFilter({ id: "a", field: "name", kind: "text", text: "  " }), null);
  });

  it("treats an emptied categorical selection as no constraint", () => {
    assert.equal(
      compileQuickFilter({
        id: "a",
        field: "state",
        kind: "categorical",
        values: [],
      }),
      null,
    );
  });

  it("ignores a disabled or fieldless control", () => {
    assert.equal(
      compileQuickFilter({
        id: "a",
        field: "state",
        kind: "categorical",
        values: ["OR"],
        enabled: false,
      }),
      null,
    );
    assert.equal(
      compileQuickFilter({
        id: "a",
        field: "",
        kind: "categorical",
        values: ["OR"],
      }),
      null,
    );
  });
});

describe("compileQuickFilters", () => {
  it("keeps only the chosen categorical values", () => {
    const kept = keptRows(
      [{ id: "a", field: "state", kind: "categorical", values: ["OR", "WA"] }],
      CITIES,
    );
    assert.deepEqual(
      kept.map((row) => row.name),
      ["Portland", "Salem", "Seattle"],
    );
  });

  it("does not conflate a numeric value with its string spelling", () => {
    const rows = [{ code: 1 }, { code: "1" }];
    assert.deepEqual(
      keptRows([{ id: "a", field: "code", kind: "categorical", values: [1] }], rows),
      [{ code: 1 }],
    );
  });

  it("applies inclusive numeric bounds and drops features missing the field", () => {
    const rows = [...CITIES, { name: "Nowhere", state: "OR" }];
    const kept = keptRows(
      [{ id: "a", field: "pop", kind: "range", min: 200_000, max: 700_000 }],
      rows,
    );
    assert.deepEqual(
      kept.map((row) => row.name),
      ["Portland", "Boise"],
    );
  });

  it("leaves an open side open", () => {
    const kept = keptRows([{ id: "a", field: "pop", kind: "range", min: 700_000 }], CITIES);
    assert.deepEqual(
      kept.map((row) => row.name),
      ["Seattle"],
    );
  });

  it("orders an inverted numeric range instead of emptying the layer", () => {
    // The two number inputs commit independently, so a max is briefly smaller
    // than its min while being typed. Compiling that literally is unsatisfiable.
    const kept = keptRows(
      [{ id: "a", field: "pop", kind: "range", min: 700_000, max: 200_000 }],
      CITIES,
    );
    assert.deepEqual(
      kept.map((row) => row.name),
      ["Portland", "Boise"],
    );
  });

  it("filters ISO dates inclusively on both bounds", () => {
    const kept = keptRows(
      [
        {
          id: "a",
          field: "founded",
          kind: "date",
          start: "1842-01-12",
          end: "1845-02-08",
        },
      ],
      CITIES,
    );
    assert.deepEqual(
      kept.map((row) => row.name),
      ["Portland", "Salem"],
    );
  });

  it("keeps a whole end day for ISO timestamps that carry a time", () => {
    const rows = [
      { name: "morning", at: "2026-03-04T00:15:00Z" },
      { name: "evening", at: "2026-03-04T23:45:00Z" },
      { name: "next day", at: "2026-03-05T00:05:00Z" },
    ];
    const kept = keptRows(
      [
        {
          id: "a",
          field: "at",
          kind: "date",
          start: "2026-03-04",
          end: "2026-03-04",
        },
      ],
      rows,
    );
    assert.deepEqual(
      kept.map((row) => row.name),
      ["morning", "evening"],
    );
  });

  it("keeps a whole end day for epoch timestamps too", () => {
    const day = Date.UTC(2026, 2, 4);
    const rows = [
      { name: "start of day", ms: day },
      { name: "end of day", ms: day + 86_399_000 },
      { name: "next day", ms: day + 86_400_000 },
    ];
    const kept = keptRows(
      [
        {
          id: "a",
          field: "ms",
          kind: "date",
          dateKind: "epochMs",
          start: "2026-03-04",
          end: "2026-03-04",
        },
      ],
      rows,
    );
    assert.deepEqual(
      kept.map((row) => row.name),
      ["start of day", "end of day"],
    );
  });

  it("scales epoch-second timestamps", () => {
    const rows = [
      { name: "in", s: Date.UTC(2026, 2, 4, 12) / 1000 },
      { name: "out", s: Date.UTC(2026, 2, 6, 12) / 1000 },
    ];
    const kept = keptRows(
      [
        {
          id: "a",
          field: "s",
          kind: "date",
          dateKind: "epochS",
          start: "2026-03-04",
          end: "2026-03-04",
        },
      ],
      rows,
    );
    assert.deepEqual(
      kept.map((row) => row.name),
      ["in"],
    );
  });

  it("ignores a half-typed date bound instead of compiling NaN", () => {
    assert.equal(
      compileQuickFilter({
        id: "a",
        field: "founded",
        kind: "date",
        start: "1845-02",
      }),
      null,
    );
  });

  it("ignores a bound that is not a real calendar day", () => {
    // `Date.parse` reads 2026-02-30 as March 2, so shape-checking alone would
    // filter on a date nobody chose.
    assert.equal(
      compileQuickFilter({ id: "a", field: "founded", kind: "date", start: "2026-02-30" }),
      null,
    );
    assert.equal(
      compileQuickFilter({
        id: "a",
        field: "founded",
        kind: "date",
        dateKind: "epochMs",
        end: "2026-13-01",
      }),
      null,
    );
  });

  it("leaves the malformed side of a half-valid date range unconstrained", () => {
    // Pushing the raw text would compare against a string no ISO day can reach,
    // which hides every feature instead of leaving that bound open.
    const kept = keptRows(
      [{ id: "a", field: "founded", kind: "date", start: "not-a-date", end: "1863-07-07" }],
      CITIES,
    );
    assert.deepEqual(
      kept.map((row) => row.name),
      ["Portland", "Salem", "Boise"],
    );
  });

  it("tolerates whitespace around a date bound", () => {
    const kept = keptRows(
      [{ id: "a", field: "founded", kind: "date", start: " 1842-01-12 ", end: "1845-02-08" }],
      CITIES,
    );
    assert.deepEqual(
      kept.map((row) => row.name),
      ["Portland", "Salem"],
    );
  });

  it("orders an inverted date range too", () => {
    const kept = keptRows(
      [{ id: "a", field: "founded", kind: "date", start: "1845-02-08", end: "1842-01-12" }],
      CITIES,
    );
    assert.deepEqual(
      kept.map((row) => row.name),
      ["Portland", "Salem"],
    );
  });

  it("matches text case-insensitively for each operator", () => {
    const rows = [{ name: "Portland" }, { name: "Port Angeles" }, { name: "Salem" }];
    const names = (filter: LayerQuickFilter) => keptRows([filter], rows).map((row) => row.name);
    assert.deepEqual(names({ id: "a", field: "name", kind: "text", text: "port" }), [
      "Portland",
      "Port Angeles",
    ]);
    assert.deepEqual(
      names({
        id: "a",
        field: "name",
        kind: "text",
        operator: "startsWith",
        text: "PORTL",
      }),
      ["Portland"],
    );
    assert.deepEqual(
      names({
        id: "a",
        field: "name",
        kind: "text",
        operator: "equals",
        text: "salem",
      }),
      ["Salem"],
    );
  });

  it("narrows with every control at once", () => {
    const kept = keptRows(
      [
        { id: "a", field: "state", kind: "categorical", values: ["OR", "WA"] },
        { id: "b", field: "pop", kind: "range", min: 700_000 },
      ],
      CITIES,
    );
    assert.deepEqual(
      kept.map((row) => row.name),
      ["Seattle"],
    );
  });

  it("compiles a single control without an all wrapper", () => {
    const compiled = compileQuickFilters([
      { id: "a", field: "state", kind: "categorical", values: ["OR"] },
    ]);
    assert.equal(compiled?.[0], "in");
  });

  it("returns null when nothing constrains the layer", () => {
    assert.equal(compileQuickFilters(undefined), null);
    assert.equal(compileQuickFilters([]), null);
    assert.equal(compileQuickFilters([{ id: "a", field: "state", kind: "categorical" }]), null);
  });
});

describe("active quick filters", () => {
  it("reports only the controls that constrain the layer", () => {
    const layer = layerWith([
      { id: "a", field: "state", kind: "categorical", values: ["OR"] },
      { id: "b", field: "pop", kind: "range" },
    ]);
    assert.deepEqual(
      activeQuickFilters(layer).map((filter) => filter.id),
      ["a"],
    );
    assert.equal(hasActiveQuickFilter(layer), true);
    assert.equal(hasActiveQuickFilter(layerWith(undefined)), false);
    assert.equal(
      hasActiveQuickFilter(layerWith([{ id: "b", field: "pop", kind: "range" }])),
      false,
    );
  });

  it("clears every selection but keeps the controls", () => {
    const cleared = clearQuickFilterValues([
      { id: "a", field: "state", kind: "categorical", values: ["OR"] },
      { id: "b", field: "pop", kind: "range", min: 1, max: 2 },
      {
        id: "c",
        field: "founded",
        kind: "date",
        start: "1845-01-01",
        end: "1846-01-01",
      },
      { id: "d", field: "name", kind: "text", text: "port" },
    ]);
    assert.equal(compileQuickFilters(cleared), null);
    assert.deepEqual(
      cleared.map((filter) => filter.field),
      ["state", "pop", "founded", "name"],
    );
  });
});

describe("profileQuickFilterFields", () => {
  const byField = (profiles: QuickFilterFieldProfile[]) =>
    new Map(profiles.map((profile) => [profile.field, profile]));

  it("suggests checkboxes with counts for a low-cardinality text field", () => {
    const state = byField(profileQuickFilterFields(CITIES)).get("state");
    assert.equal(state?.kind, "categorical");
    assert.deepEqual(state?.values, [
      { value: "OR", count: 2 },
      { value: "ID", count: 1 },
      { value: "WA", count: 1 },
    ]);
  });

  it("suggests a range with the numeric extent for a measure", () => {
    const pop = byField(profileQuickFilterFields(CITIES)).get("pop");
    assert.equal(pop?.kind, "range");
    assert.equal(pop?.min, 175_000);
    assert.equal(pop?.max, 750_000);
  });

  it("suggests a range for a numeric code column but still offers checkboxes", () => {
    const code = byField(profileQuickFilterFields(CITIES)).get("code");
    assert.equal(code?.kind, "range");
    assert.deepEqual(code?.availableKinds, ["range", "categorical"]);
  });

  it("suggests a date range for ISO values and reports the extent", () => {
    const founded = byField(profileQuickFilterFields(CITIES)).get("founded");
    assert.equal(founded?.kind, "date");
    assert.equal(founded?.dateKind, "iso");
    assert.equal(founded?.minDate, "1842-01-12");
    assert.equal(founded?.maxDate, "1869-12-02");
  });

  it("detects epoch milliseconds and seconds", () => {
    const rows = [{ ms: Date.UTC(2026, 0, 1), s: Date.UTC(2026, 0, 1) / 1000 }];
    const profiles = byField(profileQuickFilterFields(rows));
    assert.equal(profiles.get("ms")?.dateKind, "epochMs");
    assert.equal(profiles.get("s")?.dateKind, "epochS");
  });

  it("profiles numeric text as numeric, so a CSV column still gets a range", () => {
    const rows = [{ pop: "1200" }, { pop: "34" }, { pop: "-7.5" }];
    const pop = byField(profileQuickFilterFields(rows)).get("pop");
    assert.equal(pop?.kind, "range");
    assert.equal(pop?.min, -7.5);
    assert.equal(pop?.max, 1200);
  });

  it("keeps a zero-padded code a value list, not a measure", () => {
    // A ZIP or FIPS code is an identifier made of digits; a slider would both
    // misrepresent it and lose the padding.
    const rows = [{ zip: "02134" }, { zip: "02139" }, { zip: "90210" }];
    const zip = byField(profileQuickFilterFields(rows)).get("zip");
    assert.equal(zip?.kind, "categorical");
    assert.ok(!zip?.availableKinds.includes("range"));
  });

  it("still reads a padded decimal as a measure", () => {
    // The padded-identifier exclusion is for whole integers; `01.25` is a
    // number that merely happens to be written with a leading zero.
    const rows = [{ ratio: "01.25" }, { ratio: "2.5" }, { ratio: "0" }];
    const ratio = byField(profileQuickFilterFields(rows)).get("ratio");
    assert.equal(ratio?.kind, "range");
    assert.equal(ratio?.min, 0);
    assert.equal(ratio?.max, 2.5);
  });

  it("detects an epoch timestamp stored as text", () => {
    const rows = [{ at: String(Date.UTC(2026, 0, 1)) }];
    assert.equal(byField(profileQuickFilterFields(rows)).get("at")?.dateKind, "epochMs");
  });

  it("keeps a bare year column a numeric range, not a date", () => {
    const rows = [{ year: 1998 }, { year: 2012 }, { year: 2026 }];
    const year = byField(profileQuickFilterFields(rows)).get("year");
    assert.equal(year?.kind, "range");
    assert.equal(year?.dateKind, undefined);
  });

  it("does not read a mixed text column as a date", () => {
    const rows = [{ when: "2026-01-01" }, { when: "sometime" }];
    const when = byField(profileQuickFilterFields(rows)).get("when");
    assert.notEqual(when?.kind, "date");
    assert.ok(when?.availableKinds.includes("text"));
  });

  it("falls back to a text match once a field has too many distinct values", () => {
    const rows = Array.from({ length: 300 }, (_, index) => ({
      id: `feature-${index}`,
    }));
    const id = byField(profileQuickFilterFields(rows)).get("id");
    assert.equal(id?.kind, "text");
    assert.equal(id?.valuesTruncated, true);
    assert.deepEqual(id?.values, []);
    assert.ok(!id?.availableKinds.includes("categorical"));
  });

  it("counts only the features that carry a value", () => {
    const rows = [{ a: 1 }, { a: null }, { a: "" }, { a: 2 }];
    const a = byField(profileQuickFilterFields(rows)).get("a");
    assert.equal(a?.sampled, 4);
    assert.equal(a?.present, 2);
  });

  it("counts every feature by default, not a leading sample", () => {
    // 8,031 features (more than the 5,000 the profile used to stop at), with
    // the rarer values and the extreme magnitude only past row 5,000: the
    // counts and extents must describe the whole layer.
    const rows = Array.from({ length: 8031 }, (_, index) => ({
      magType: index < 5000 ? "ml" : index % 3 === 0 ? "md" : "ml",
      mag: index === 8030 ? 7.1 : 1 + (index % 30) / 10,
    }));
    const expectedMd = rows.filter((row) => row.magType === "md").length;
    const profiles = byField(profileQuickFilterFields(rows));
    const magType = profiles.get("magType");
    assert.equal(magType?.sampled, 8031);
    assert.equal(magType?.present, 8031);
    assert.deepEqual(magType?.values, [
      { value: "ml", count: 8031 - expectedMd },
      { value: "md", count: expectedMd },
    ]);
    const total = (magType?.values ?? []).reduce((sum, entry) => sum + entry.count, 0);
    assert.equal(total, 8031);
    assert.equal(profiles.get("mag")?.max, 7.1);
  });

  it("stops at the profile limit on a very large layer", () => {
    const rows = Array.from({ length: QUICK_FILTER_PROFILE_LIMIT + 10 }, (_, index) => ({
      a: index % 2,
    }));
    const a = byField(profileQuickFilterFields(rows)).get("a");
    assert.equal(a?.sampled, QUICK_FILTER_PROFILE_LIMIT);
    assert.equal(a?.present, QUICK_FILTER_PROFILE_LIMIT);
  });

  it("honors the sample limit and the exclusion list", () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      a: index,
      secret: index,
    }));
    const profiles = profileQuickFilterFields(rows, {
      sampleLimit: 3,
      exclude: ["secret"],
    });
    assert.deepEqual(
      profiles.map((profile) => profile.field),
      ["a"],
    );
    assert.equal(profiles[0]?.sampled, 3);
  });
});

describe("createQuickFilterScan (issue #3426)", () => {
  const rows = Array.from({ length: 2000 }, (_, index) => ({
    state: index % 2 === 0 ? "TN" : "OR",
    pop: index,
    ...(index === 1500 ? { late: "x" } : {}),
  }));

  it("profiles only the requested fields, identically to a full pass", () => {
    const full = new Map(profileQuickFilterFields(rows).map((p) => [p.field, p]));
    const only = profileQuickFilterFields(rows, { fields: ["pop"] });
    assert.deepEqual(
      only.map((profile) => profile.field),
      ["pop"],
    );
    assert.deepEqual(only[0], full.get("pop"));
  });

  it("gives no profile to a requested field the records do not carry", () => {
    assert.deepEqual(profileQuickFilterFields(rows, { fields: ["missing"] }), []);
  });

  it("lists field names without tallying any values", () => {
    const scan = createQuickFilterScan(rows, { fields: [], names: true });
    assert.equal(scan.step(), true);
    assert.deepEqual(scan.fieldNames(), ["state", "pop", "late"]);
    assert.deepEqual(scan.profiles(), []);
  });

  it("reads features in place through a property accessor", () => {
    const features = rows.map((properties) => ({ type: "Feature", properties }));
    const [state] = profileQuickFilterFields(features, {
      fields: ["state"],
      properties: (feature) => feature.properties,
    });
    assert.deepEqual(state?.values, [
      { value: "OR", count: 1000 },
      { value: "TN", count: 1000 },
    ]);
  });

  it("resumes across slices and matches a single pass", () => {
    const scan = createQuickFilterScan(rows, { fields: ["state", "pop"] });
    let slices = 1;
    // Asking to yield at every poll forces the smallest possible slices.
    while (!scan.step(() => true)) slices += 1;
    assert.ok(slices > 1, "a 2,000-record scan should take more than one slice");
    assert.deepEqual(scan.profiles(), profileQuickFilterFields(rows, { fields: ["state", "pop"] }));
  });
});

describe("ensureQuickFilterProfiles (issue #3426)", () => {
  const makeRows = (length = 3000) =>
    Array.from({ length }, (_, index) => ({ state: index % 3 === 0 ? "TN" : "OR", pop: index }));

  it("answers a small request synchronously and caches it by array identity", () => {
    const rows = makeRows(10);
    assert.equal(readQuickFilterProfileCache(rows), undefined);
    let done = 0;
    ensureQuickFilterProfiles(rows, { fields: ["state"], names: true }, { onDone: () => done++ });
    assert.equal(done, 1);
    const cached = readQuickFilterProfileCache(rows);
    assert.deepEqual(cached?.names, ["state", "pop"]);
    assert.equal(cached?.profiles.get("state")?.kind, "categorical");
    // Only what was asked for is profiled.
    assert.equal(cached?.profiles.has("pop"), false);
    assert.equal(hasQuickFilterProfiles(rows, { fields: ["state"], names: true }), true);
    assert.equal(hasQuickFilterProfiles(rows, { fields: ["pop"] }), false);
    // An equal but distinct array is a different dataset.
    assert.equal(readQuickFilterProfileCache(makeRows(10)), undefined);
  });

  it("scans only the fields the cache is missing", () => {
    const rows = makeRows(10);
    ensureQuickFilterProfiles(rows, { fields: ["state"] });
    const first = readQuickFilterProfileCache(rows)?.profiles.get("state");
    let reads = 0;
    ensureQuickFilterProfiles(
      rows,
      { fields: ["state", "pop"] },
      {
        properties: (row) => {
          reads += 1;
          // A second tally of `state` would double its counts.
          return row;
        },
      },
    );
    assert.equal(reads, rows.length);
    const cached = readQuickFilterProfileCache(rows);
    assert.equal(cached?.profiles.get("state"), first);
    assert.equal(cached?.profiles.get("pop")?.kind, "range");
    // Fully cached: no scan at all, and `onDone` still fires.
    let done = 0;
    ensureQuickFilterProfiles(
      rows,
      { fields: ["pop"] },
      {
        properties: () => assert.fail("a cached request must not rescan"),
        onDone: () => done++,
      },
    );
    assert.equal(done, 1);
  });

  it("remembers a field no record carries instead of rescanning for it", () => {
    const rows = makeRows(10);
    ensureQuickFilterProfiles(rows, { fields: ["missing"] });
    assert.equal(readQuickFilterProfileCache(rows)?.profiles.get("missing"), null);
    assert.equal(hasQuickFilterProfiles(rows, { fields: ["missing"] }), true);
  });

  it("slices a large scan across tasks and commits nothing until it finishes", async () => {
    const rows = makeRows();
    const yields: (() => void)[] = [];
    let done = 0;
    let clock = 0;
    ensureQuickFilterProfiles(
      rows,
      { fields: ["state"], names: true },
      {
        onDone: () => done++,
        sliceBudgetMs: 1,
        // Every poll sees the budget spent, so each slice is one poll long.
        now: () => (clock += 1),
        yieldControl: () => new Promise<void>((resolve) => yields.push(resolve)),
      },
    );
    assert.equal(done, 0, "the first slice must not finish a 3,000-record scan");
    assert.equal(readQuickFilterProfileCache(rows), undefined);

    let slices = 1;
    while (done === 0) {
      const next = yields.shift();
      assert.ok(next, "the scan should be waiting on a yield");
      next();
      await new Promise((resolve) => setImmediate(resolve));
      slices += 1;
      assert.ok(slices < 100, "the scan should terminate");
    }
    assert.ok(slices > 2);
    assert.deepEqual(readQuickFilterProfileCache(rows)?.profiles.get("state")?.values, [
      { value: "OR", count: 2000 },
      { value: "TN", count: 1000 },
    ]);
  });

  it("drops a cancelled scan without caching or calling back", async () => {
    const rows = makeRows();
    const yields: (() => void)[] = [];
    let done = 0;
    let clock = 0;
    const cancel = ensureQuickFilterProfiles(
      rows,
      { fields: ["state"] },
      {
        onDone: () => done++,
        sliceBudgetMs: 1,
        now: () => (clock += 1),
        yieldControl: () => new Promise<void>((resolve) => yields.push(resolve)),
      },
    );
    cancel();
    yields.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done, 0);
    assert.equal(yields.length, 0);
    assert.equal(readQuickFilterProfileCache(rows), undefined);
  });

  it("settles the caller without caching when a later slice throws", async (t) => {
    t.mock.method(console, "error", () => {});
    const rows = makeRows();
    let done = 0;
    let clock = 0;
    let reads = 0;
    ensureQuickFilterProfiles(
      rows,
      { fields: ["state"] },
      {
        onDone: () => done++,
        sliceBudgetMs: 1,
        now: () => (clock += 1),
        yieldControl: () => Promise.resolve(),
        properties: (row) => {
          reads += 1;
          if (reads > 1000) throw new Error("unreadable record");
          return row;
        },
      },
    );
    assert.equal(done, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done, 1, "a failed scan must still call back");
    assert.equal(readQuickFilterProfileCache(rows), undefined);
  });
});
