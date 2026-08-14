#!/usr/bin/env node
// Smoke-test a *running* GeoLibre collaboration relay: health, session
// creation, and a WebSocket join round-trip.
//
// The relay's worst failure mode is an image that builds clean and then exits at
// startup because the runtime stage is missing a dependency the bundle imports
// (GeoLibre#1866). No unit test or type-check sees that, and neither does
// `docker build` -- only starting the container does. So CI builds the image,
// runs it, and points this script at it. It talks plain HTTP plus the global
// WebSocket, so it needs nothing installed beyond Node itself and can be aimed
// at any deployed relay:
//
//   node workers/collab-node/scripts/smoke.mjs http://127.0.0.1:8787

const baseUrl = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
// Generous: on a cold CI runner the container has to start Node and open the
// SQLite database before it listens.
const STARTUP_TIMEOUT_MS = 60_000;
const WS_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;

function fail(message, detail) {
  console.error(`FAIL: ${message}`);
  if (detail !== undefined) console.error(detail);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      // Bounded, because a container that accepts the connection and then never
      // answers falls back on undici's own header/body timeouts, which are
      // minutes long: the job would stall well past the startup budget instead
      // of failing at it. Capped at whatever is left of that budget so a probe
      // started near the deadline cannot overrun it either.
      const signal = AbortSignal.timeout(Math.min(PROBE_TIMEOUT_MS, deadline - Date.now()));
      const response = await fetch(`${baseUrl}/health`, { signal });
      // The same signal still covers this: aborting after the headers arrive
      // errors the body stream rather than leaving the read hanging.
      const body = await response.json();
      if (response.ok && body?.ok) return body;
      lastError = `HTTP ${response.status} ${JSON.stringify(body)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  fail(`the relay never answered GET /health at ${baseUrl}`, lastError);
}

async function createSession() {
  const response = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    // Bounded for the same reason as the health probe: the relay has answered
    // by now, so anything slower than this is a hang, not a slow start.
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.sessionId || !body?.hostToken)
    fail(
      "POST /sessions did not return a session",
      `HTTP ${response.status} ${JSON.stringify(body)}`,
    );
  return body;
}

// The join round-trip is the part that actually exercises `ws`: the relay only
// reaches WebSocketServer.handleUpgrade here, so a missing or broken copy of it
// shows up as a failed upgrade rather than a passing health check.
function join(session) {
  const wsUrl = `${baseUrl.replace(/^http/, "ws")}/sessions/${session.sessionId}/ws`;
  return new Promise((resolve) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      socket.close();
      fail(`no welcome frame within ${WS_TIMEOUT_MS}ms of joining ${wsUrl}`);
    }, WS_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "join",
          clientId: "smoke-test",
          displayName: "Smoke test",
          color: "#2563eb",
          hostToken: session.hostToken,
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        fail("the relay sent a frame that is not JSON", String(event.data).slice(0, 200));
      }
      if (message.type !== "welcome")
        fail(
          `expected a welcome frame, got "${message.type}"`,
          JSON.stringify(message).slice(0, 200),
        );
      if (message.role !== "host")
        fail(`the host token did not claim the host role (got "${message.role}")`);
      socket.close();
      resolve(message);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      fail(`the WebSocket upgrade to ${wsUrl} failed`);
    });
  });
}

const health = await waitForHealth();
console.log(`ok  GET /health -> ${JSON.stringify(health)}`);
const session = await createSession();
console.log(`ok  POST /sessions -> ${session.sessionId} (${session.mode})`);
const welcome = await join(session);
console.log(
  `ok  WebSocket join -> welcome as ${welcome.role}, ${welcome.participants.length} participant(s)`,
);
console.log(`PASS: the relay at ${baseUrl} is serving`);
