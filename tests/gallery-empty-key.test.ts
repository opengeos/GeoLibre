import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { galleryEmptyKey } from "../apps/geolibre-desktop/src/lib/gallery-empty-key";

describe("galleryEmptyKey", () => {
  it("reports a filter miss separately for collections and projects", () => {
    assert.equal(galleryEmptyKey("collections", true, true), "gallery.noCollectionMatches");
    assert.equal(galleryEmptyKey("collections", false, true), "gallery.noMatches");
    assert.equal(galleryEmptyKey("all", false, true), "gallery.noMatches");
  });

  it("tells an empty collection list from an empty collection", () => {
    assert.equal(galleryEmptyKey("collections", true, false), "gallery.emptyCollections");
    assert.equal(galleryEmptyKey("collections", false, false), "gallery.emptyCollection");
  });

  it("uses each project scope's own empty message", () => {
    assert.equal(galleryEmptyKey("mine", false, false), "gallery.emptyMine");
    assert.equal(galleryEmptyKey("organizations", false, false), "gallery.emptyOrganizations");
    assert.equal(galleryEmptyKey("groups", false, false), "gallery.emptyGroups");
    assert.equal(galleryEmptyKey("featured", false, false), "gallery.emptyFeatured");
    assert.equal(galleryEmptyKey("all", false, false), "gallery.empty");
  });
});
