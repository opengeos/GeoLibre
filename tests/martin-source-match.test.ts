import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { martinSourceMatchesTable } from "../apps/geolibre-desktop/src/components/layout/add-data/martin-source-match";

describe("martinSourceMatchesTable", () => {
  it("matches a public-schema table by its bare source id", () => {
    assert.equal(martinSourceMatchesTable("roads", "public", "roads"), true);
  });

  it("matches a public-schema table by the qualified source id too", () => {
    assert.equal(martinSourceMatchesTable("public.roads", "public", "roads"), true);
  });

  it("matches an unknown-schema table by the bare source id", () => {
    assert.equal(martinSourceMatchesTable("roads", undefined, "roads"), true);
  });

  it("matches a non-public table only by its qualified source id", () => {
    assert.equal(martinSourceMatchesTable("census.roads", "census", "roads"), true);
  });

  it("does not match a non-public table by a bare source id", () => {
    // The collision the matcher exists to prevent: a public.roads source must
    // not be selected for a clicked census.roads.
    assert.equal(martinSourceMatchesTable("roads", "census", "roads"), false);
    assert.equal(martinSourceMatchesTable("public.roads", "census", "roads"), false);
  });

  it("does not match a different table name", () => {
    assert.equal(martinSourceMatchesTable("rivers", "public", "roads"), false);
  });
});
