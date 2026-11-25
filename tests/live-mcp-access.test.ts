import assert from "node:assert/strict";
import { it } from "node:test";
import { createLiveMcpAccessController } from "../apps/geolibre-desktop/src/lib/live-mcp-access";

const SERVER = { baseUrl: "http://127.0.0.1:8765", port: 8765, token: "test" };

it("retries a possible grant after a renderer reload or sidecar reattachment", async () => {
  let granted = false;
  let enabled = true;
  let fail = false;
  const requests: boolean[] = [];
  const options = {
    getEnabled: () => enabled,
    grants: {
      get: () => granted,
      set: (_info: typeof SERVER, value: boolean) => {
        granted = value;
      },
    },
    send: async (_info: typeof SERVER, value: boolean) => {
      requests.push(value);
      if (fail) throw new Error("offline");
    },
  };
  const first = createLiveMcpAccessController(options);
  first.setServer(SERVER);
  await first.sync();
  enabled = false;
  fail = true;
  await first.sync();
  first.setServer(null);
  assert.equal(granted, true);
  const reloaded = createLiveMcpAccessController(options);
  reloaded.setServer(SERVER);
  fail = false;
  await reloaded.sync();
  assert.deepEqual(requests, [true, false, false]);
  assert.equal(granted, false);
  reloaded.setServer(null);
});

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
    getEnabled: () => true,
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

it("does not send or warn about revocation for a server that was never enabled", async (t) => {
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
  t.mock.timers.tick(60000);
  await Promise.resolve();
  assert.equal(requests, 0);
  assert.deepEqual(controller.getState(), { ready: null, enabled: false, error: false });
  controller.setServer(null);
});

it("revokes a possibly accepted enable even when its response was lost", async () => {
  let enabled = true;
  const requests: boolean[] = [];
  const controller = createLiveMcpAccessController({
    getEnabled: () => enabled,
    send: async (_server, desired) => {
      requests.push(desired);
      if (desired) throw new Error("enable response lost");
    },
  });
  controller.setServer(SERVER);
  await controller.sync();
  enabled = false;
  await controller.sync();
  await controller.sync();
  assert.deepEqual(requests, [true, false]);
  assert.equal(controller.getState().error, false);
  controller.setServer(null);
});

it("keeps listener failures separate from server synchronization failures", async (t) => {
  const warnings = t.mock.method(console, "error", () => {});
  let requests = 0;
  const controller = createLiveMcpAccessController({
    getEnabled: () => true,
    send: async () => {
      requests += 1;
    },
  });
  controller.subscribe(() => {
    throw new Error("listener bug");
  });
  controller.setServer(SERVER);
  await controller.sync();
  assert.equal(requests, 1);
  assert.deepEqual(controller.getState(), { ready: SERVER, enabled: true, error: false });
  assert.ok(warnings.mock.callCount() > 0);
  controller.setServer(null);
});
