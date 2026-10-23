import assert from "node:assert/strict";
import { it } from "node:test";
import { loadAdminProfile } from "../apps/geolibre-desktop/src/lib/admin-profile";
import { setDeploymentPolicy } from "../apps/geolibre-desktop/src/lib/deployment-env";

it("a policy interface replaces admin-profile.json without fetching it", async (t) => {
  let fetched = false;
  t.mock.method(globalThis, "fetch", async () => {
    fetched = true;
    throw new Error("admin-profile.json must not be read");
  });
  try {
    setDeploymentPolicy({
      version: 1,
      interface: { level: "beginner", lock: true },
    });
    const patch = await loadAdminProfile([]);
    assert.equal(patch?.level, "beginner");
    assert.equal(patch?.locked, true);
    assert.equal(patch?.onboarded, true);
    assert.equal(fetched, false);
  } finally {
    setDeploymentPolicy(null);
  }
});

it("an empty policy interface counts as absent and admin-profile.json still applies", async (t) => {
  let requested = "";
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    requested = String(input);
    return new Response(JSON.stringify({ level: "beginner", lock: true }));
  });
  try {
    setDeploymentPolicy({ version: 1, interface: {} });
    const patch = await loadAdminProfile([]);
    assert.match(requested, /admin-profile\.json$/);
    assert.equal(patch?.level, "beginner");
    assert.equal(patch?.locked, true);
  } finally {
    setDeploymentPolicy(null);
  }
});
