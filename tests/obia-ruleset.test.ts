import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classMembership,
  membershipValue,
  runRuleset,
  validateRuleset,
  type ObiaAdjacency,
  type ObiaFeatureTable,
} from "@geolibre/processing";

/** Five objects in a row, 1-2-3-4-5, each bordering the next by 2 edges. */
function row(ndvi: number[]): { table: ObiaFeatureTable; adjacency: ObiaAdjacency } {
  const table: ObiaFeatureTable = {
    fields: ["ndvi"],
    rows: new Map(ndvi.map((v, i) => [i + 1, { ndvi: v }])),
  };
  const adjacency: ObiaAdjacency = new Map();
  for (let id = 1; id <= ndvi.length; id += 1) {
    const m = new Map<number, number>();
    if (id > 1) m.set(id - 1, 2);
    if (id < ndvi.length) m.set(id + 1, 2);
    adjacency.set(id, m);
  }
  return { table, adjacency };
}

describe("OBIA rulesets", () => {
  it("evaluates membership functions", () => {
    const larger = { field: "x", type: "larger", from: 0, to: 10 } as const;
    assert.equal(membershipValue(larger, -1), 0);
    assert.equal(membershipValue(larger, 5), 0.5);
    assert.equal(membershipValue(larger, 20), 1);
    assert.equal(membershipValue({ field: "x", type: "smaller", from: 0, to: 10 }, 2.5), 0.75);
    assert.equal(membershipValue({ field: "x", type: "about", center: 5, width: 2 }, 6), 0.5);
    assert.equal(membershipValue(larger, null), null);
    const value = (field: string) => ({ a: 5, b: 8 })[field];
    const memberships = [
      { field: "a", type: "larger" as const, from: 0, to: 10 },
      { field: "b", type: "larger" as const, from: 0, to: 10 },
    ];
    assert.equal(classMembership({ className: "c", memberships }, value), 0.5);
    assert.equal(classMembership({ className: "c", combine: "or", memberships }, value), 0.8);
    assert.equal(classMembership({ className: "c", combine: "mean", memberships }, value), 0.65);
  });

  it("classifies by fuzzy descriptions, leaving weak members alone", () => {
    const { table, adjacency } = row([0.8, 0.5, 0.05, -0.3, 0.02]);
    const { predictions } = runRuleset(table, adjacency, ["veg", "water"], {
      processes: [
        {
          kind: "fuzzy",
          minMembership: 0.3,
          classes: [
            {
              className: "veg",
              memberships: [{ field: "ndvi", type: "larger", from: 0, to: 0.6 }],
            },
            {
              className: "water",
              memberships: [{ field: "ndvi", type: "smaller", from: -0.2, to: 0 }],
            },
          ],
        },
      ],
    });
    assert.deepEqual([...predictions].sort(), [
      [1, "veg"],
      [2, "veg"],
      [4, "water"],
    ]);
  });

  it("scopes processes to a domain and grows a class in a loop", () => {
    const { table, adjacency } = row([0.8, 0.1, 0.1, 0.1, 0.9]);
    const { predictions, log } = runRuleset(table, adjacency, ["veg", "other"], {
      processes: [
        {
          kind: "assign",
          name: "seed",
          domain: { conditions: [{ field: "ndvi", op: ">", value: 0.85 }] },
          className: "veg",
        },
        {
          kind: "loop",
          name: "grow",
          processes: [
            {
              kind: "assign",
              domain: {
                classes: [""],
                conditions: [{ field: "nb_border_veg", op: ">", value: 0 }],
              },
              className: "veg",
            },
          ],
        },
        {
          kind: "assign",
          domain: { classes: ["veg"], conditions: [{ field: "ndvi", op: ">", value: 0.5 }] },
          className: "other",
        },
      ],
    });
    // Object 5 seeds; the loop spreads to 4, 3, 2, 1 (one ring per pass);
    // the last process re-labels the bright vegetation.
    assert.deepEqual([...predictions].sort(), [
      [1, "other"],
      [2, "veg"],
      [3, "veg"],
      [4, "veg"],
      [5, "other"],
    ]);
    assert.deepEqual(log, [
      { path: "1", name: "seed", changed: 1 },
      { path: "2", name: "grow", changed: 4, iterations: 5 },
      { path: "2.1", name: "assign", changed: 4 },
      { path: "3", name: "assign", changed: 2 },
    ]);
  });

  it("validates a ruleset and names the first problem", () => {
    const fields = ["ndvi"];
    assert.ok(
      "ruleset" in validateRuleset({ processes: [{ kind: "assign", className: "x" }] }, fields),
    );
    const error = (value: unknown) => {
      const result = validateRuleset(value, fields);
      return "error" in result ? result.error : "";
    };
    assert.match(error({ processes: [] }), /at least one process/);
    assert.match(error({ processes: [{ kind: "split" }] }), /unknown kind "split"/);
    assert.match(
      error({
        processes: [
          {
            kind: "assign",
            className: "x",
            domain: { conditions: [{ field: "nope", op: ">", value: 1 }] },
          },
        ],
      }),
      /unknown field "nope"/,
    );
    assert.match(
      error({
        processes: [
          {
            kind: "loop",
            processes: [
              {
                kind: "fuzzy",
                classes: [
                  {
                    className: "a",
                    memberships: [{ field: "ndvi", type: "larger", from: 1, to: 0 }],
                  },
                ],
              },
            ],
          },
        ],
      }),
      /^process 1\.1: class 1 membership 1 needs numbers from < to$/,
    );
    assert.ok(
      "ruleset" in
        validateRuleset(
          {
            processes: [
              {
                kind: "assign",
                className: "x",
                domain: { conditions: [{ field: "nb_border_water", op: ">", value: 0.5 }] },
              },
            ],
          },
          fields,
        ),
    );
  });
});

describe("OBIA ruleset editor helpers", () => {
  it("offers a valid example and reports JSON errors", async () => {
    const { exampleRuleset, parseRuleset } =
      await import("../apps/geolibre-desktop/src/lib/obia/obia-ruleset-run");
    const fields = ["mean_b1", "ndvi"];
    const example = exampleRuleset(["Trees, shrubs", "built"], fields);
    const parsed = parseRuleset(example, fields);
    assert.ok("ruleset" in parsed, JSON.stringify(parsed));
    assert.match(example, /nb_border_trees_shrubs/);
    const broken = parseRuleset("{ not json", fields);
    assert.ok("error" in broken);
  });
});
