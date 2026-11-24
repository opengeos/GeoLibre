import assert from "node:assert/strict";
import { it } from "node:test";
import { createLiveMcpAccessController } from "../apps/geolibre-desktop/src/lib/live-mcp-access";

const SERVER = { baseUrl: "http://127.0.0.1:8765", port: 8765, token: "test" };

it("retries a failed revocation while immediately removing the app subscription", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let enabled = true;
  let fail = false;
  const requests: boolean[] = [];
  const controller = createLiveMcpAccessController({
    getEnabled: () => enabled,
    send: async (_info, desired) => {
      requests.push(desired);
      if (fail) throw new Error("offline");
    },
  });
  try {
    controller.setServer(SERVER);
    await controller.sync();
    assert.equal(controller.getState().ready, SERVER);
    enabled = false;
    fail = true;
    const disabling = controller.sync();
    assert.equal(controller.getState().ready, null);
    await disabling;
    assert.equal(controller.getState().error, true);
    fail = false;
    t.mock.timers.tick(1000);
    // Let the timer's queued request and completion run.
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(requests, [true, false, false]);
    assert.deepEqual(controller.getState(), { ready: null, enabled: false, error: false });
  } finally {
    controller.setServer(null);
  }
});

it("stops retrying when the server stops", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requests = 0;
  const controller = createLiveMcpAccessController({
    getEnabled: () => false,
    send: async () => {
      requests += 1;
      throw new Error("offline");
    },
  });
  controller.setServer(SERVER);
  await controller.sync();
  controller.setServer(null);
  t.mock.timers.tick(60000);
  await Promise.resolve();
  assert.equal(requests, 1);
  assert.equal(controller.getState().error, false);
});

it("does not publish a late enable after the preference has been revoked", async () => {
  let enabled = true;
  let release!: () => void;
  const requests: boolean[] = [];
  const controller = createLiveMcpAccessController({
    getEnabled: () => enabled,
    send: async (_info, desired) => {
      requests.push(desired);
      if (desired)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    },
  });
  controller.setServer(SERVER);
  const enabling = controller.sync();
  await Promise.resolve();
  enabled = false;
  const disabling = controller.sync();
  release();
  await Promise.all([enabling, disabling]);
  assert.deepEqual(requests, [true, false]);
  assert.equal(controller.getState().ready, null);
  assert.equal(controller.getState().enabled, false);
  controller.setServer(null);
});
