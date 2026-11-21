import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { isPublicHttpUrl } = await import("../apps/geolibre-desktop/src/lib/layer-refresh");

describe("isPublicHttpUrl", () => {
  it("allows public http(s) hosts", () => {
    assert.equal(isPublicHttpUrl("https://example.com/data.json"), true);
    assert.equal(isPublicHttpUrl("http://example.com/data.json"), true);
  });
  it("blocks loopback (IPv4/IPv6/localhost)", () => {
    assert.equal(isPublicHttpUrl("http://localhost/x"), false);
    assert.equal(isPublicHttpUrl("http://foo.localhost/x"), false);
    assert.equal(isPublicHttpUrl("http://127.0.0.1/x"), false);
    assert.equal(isPublicHttpUrl("http://127.5.5.5/x"), false);
    assert.equal(isPublicHttpUrl("http://[::1]/x"), false);
    assert.equal(isPublicHttpUrl("http://0.0.0.0/x"), false);
  });
  it("blocks private ranges", () => {
    assert.equal(isPublicHttpUrl("http://10.0.0.1/x"), false);
    assert.equal(isPublicHttpUrl("http://192.168.1.1/x"), false);
    assert.equal(isPublicHttpUrl("http://172.16.0.1/x"), false);
    assert.equal(isPublicHttpUrl("http://172.31.255.255/x"), false);
    assert.equal(isPublicHttpUrl("http://169.254.1.1/x"), false);
  });
  it("blocks non-http schemes", () => {
    assert.equal(isPublicHttpUrl("gs://bucket/key"), false);
    assert.equal(isPublicHttpUrl("s3://bucket/key"), false);
    assert.equal(isPublicHttpUrl("ftp://example.com/x"), false);
  });
  it("blocks reserved/benchmark ranges", () => {
    assert.equal(isPublicHttpUrl("http://192.0.0.1/x"), false);
    assert.equal(isPublicHttpUrl("http://198.18.0.1/x"), false);
    assert.equal(isPublicHttpUrl("http://240.0.0.1/x"), false);
  });
  it("blocks IPv4-compatible IPv6 literals", () => {
    assert.equal(isPublicHttpUrl("http://[::127.0.0.1]/x"), false);
    assert.equal(isPublicHttpUrl("http://[::a00:1]/x"), false);
    assert.equal(isPublicHttpUrl("http://[2001:db8::1]/x"), true);
  });
});
