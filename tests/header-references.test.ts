import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allowsCredentialHeaders,
  isHeaderReferenceOnly,
  resolveHeaderReferences,
} from "@geolibre/core";

describe("resolveHeaderReferences", () => {
  it("substitutes variables and leaves literal headers alone", () => {
    assert.deepEqual(
      resolveHeaderReferences({ Authorization: "Bearer ${T}", X: "plain" }, { T: "abc" }),
      { Authorization: "Bearer abc", X: "plain" },
    );
  });

  it("drops a header whose variable is unset or empty instead of sending a hole", () => {
    const headers = { Authorization: "Bearer ${T}", X: "plain" };
    assert.deepEqual(resolveHeaderReferences(headers, {}), { X: "plain" });
    assert.deepEqual(resolveHeaderReferences(headers, { T: "" }), { X: "plain" });
    assert.equal(resolveHeaderReferences({ Authorization: "Bearer ${T}" }, {}), undefined);
  });

  it("does not resolve inherited object properties as variables", () => {
    assert.equal(resolveHeaderReferences({ A: "${toString}" }, {}), undefined);
  });
});

describe("isHeaderReferenceOnly", () => {
  it("accepts a scheme word plus one reference and nothing else", () => {
    for (const value of ["Bearer ${T}", "${T}", "ApiKey  ${T}", " Token ${T} "]) {
      assert.equal(isHeaderReferenceOnly(value), true, value);
    }
    for (const value of ["abc${T}", "${T}${U}", "Bearer ${T} x", "Bearer abc", "Bearer ${1T}"]) {
      assert.equal(isHeaderReferenceOnly(value), false, value);
    }
  });
});

describe("allowsCredentialHeaders", () => {
  it("allows HTTPS and loopback HTTP only", () => {
    for (const url of [
      "https://a.example/t.json",
      "HTTPS://a.example/t.json",
      "http://localhost:8080/t",
      "http://127.0.0.1/t",
      "http://[::1]/t",
    ]) {
      assert.equal(allowsCredentialHeaders(url), true, url);
    }
    for (const url of [
      "http://a.example/t.json",
      "ftp://a.example/t",
      "/relative/t.json",
      "not a url",
    ]) {
      assert.equal(allowsCredentialHeaders(url), false, url);
    }
  });
});
