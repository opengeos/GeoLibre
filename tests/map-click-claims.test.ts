import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMapClickClaimed, registerMapClickClaim } from "@geolibre/core";

describe("map click claims", () => {
  it("reports a claim only while a registered tool is drawing", () => {
    let drawing = false;
    const release = registerMapClickClaim(() => drawing);
    try {
      assert.equal(isMapClickClaimed(), false);
      drawing = true;
      assert.equal(isMapClickClaimed(), true);
      drawing = false;
      assert.equal(isMapClickClaimed(), false);
    } finally {
      release();
    }
  });

  it("drops the claim once released", () => {
    const release = registerMapClickClaim(() => true);
    assert.equal(isMapClickClaimed(), true);
    release();
    assert.equal(isMapClickClaimed(), false);
  });

  it("holds while any one of several tools is drawing", () => {
    let measuring = false;
    const releaseMeasure = registerMapClickClaim(() => measuring);
    const releaseIdle = registerMapClickClaim(() => false);
    try {
      assert.equal(isMapClickClaimed(), false);
      measuring = true;
      assert.equal(isMapClickClaimed(), true);
    } finally {
      releaseMeasure();
      releaseIdle();
    }
  });

  it("treats a throwing claim as no claim", () => {
    const release = registerMapClickClaim(() => {
      throw new Error("control torn down");
    });
    try {
      assert.equal(isMapClickClaimed(), false);
    } finally {
      release();
    }
  });

  it("keeps two registrations of one predicate independent", () => {
    const shared = () => true;
    const releaseFirst = registerMapClickClaim(shared);
    const releaseSecond = registerMapClickClaim(shared);
    try {
      releaseFirst();
      assert.equal(isMapClickClaimed(), true);
    } finally {
      releaseSecond();
    }
    assert.equal(isMapClickClaimed(), false);
  });
});
