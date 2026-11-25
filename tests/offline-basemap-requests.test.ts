import assert from "node:assert/strict";
import { it } from "node:test";
import { OfflineBasemapRequests } from "../apps/geolibre-desktop/src/lib/offline-basemap-requests";

it("ignores a late verification after a newer basemap choice, even when the URL is unchanged", async () => {
  const state = { projectLoadCount: 1, basemapChoiceGeneration: 1 };
  const requests = new OfflineBasemapRequests(() => state);
  const request = requests.begin();
  let finish!: () => void;
  const verification = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let applied = false;
  const pending = verification.then(() => {
    if (request.isCurrent()) applied = true;
  });
  state.basemapChoiceGeneration++;
  finish();
  await pending;
  assert.equal(applied, false);
  assert.equal(request.isLatest(), true, "the original request can still clear its own spinner");
});

it("invalidates work on panel close and prevents an old request clearing a newer spinner", () => {
  const requests = new OfflineBasemapRequests(() => ({
    projectLoadCount: 1,
    basemapChoiceGeneration: 1,
  }));
  const old = requests.begin();
  const next = requests.begin();
  assert.equal(old.isLatest(), false);
  assert.equal(old.isCurrent(), false);
  assert.equal(next.isCurrent(), true);
  requests.invalidate();
  assert.equal(next.isCurrent(), false);
});

it("does not apply a package read for a replaced project", () => {
  const state = { projectLoadCount: 1, basemapChoiceGeneration: 1 };
  const requests = new OfflineBasemapRequests(() => state);
  const request = requests.begin();
  state.projectLoadCount++;
  assert.equal(request.isCurrent(), false);
  assert.equal(requests.begin().isCurrent(), true);
});

it("keeps catalog notifications owned after applying a basemap but drops them for a new project", () => {
  const state = { projectLoadCount: 1, basemapChoiceGeneration: 1 };
  const requests = new OfflineBasemapRequests(() => state);
  const request = requests.begin();
  state.basemapChoiceGeneration++;
  assert.equal(request.isCurrent(), false);
  assert.equal(request.isProjectCurrent(), true);
  state.projectLoadCount++;
  assert.equal(request.isProjectCurrent(), false);
});
