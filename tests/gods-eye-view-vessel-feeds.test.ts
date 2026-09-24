import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  AISSTREAM_URL,
  AIS_VESSEL_TTL_MS,
  AisStreamClient,
  parseAisMessage,
  vesselCategory,
  vesselsToCzml,
  type AisConnectionState,
  type AisSocket,
  type VesselObservation,
} from "../packages/plugins/src/plugins/gods-eye-view-vessel-feeds";
import {
  GODS_EYE_VIEW_KEY_STORAGE_PREFIX,
  resolveGodsEyeViewKey,
  writeStoredGodsEyeViewKey,
} from "../packages/plugins/src/plugins/gods-eye-view-keys";

// Frames exactly as AISStream sent them on 2026-09-24 (New York harbor).
const positionReport = {
  MetaData: {
    MMSI: 367779550,
    ShipName: "SUNSET CROSSING     ",
    latitude: 40.73024,
    longitude: -73.96392,
    time_utc: "2026-09-24 16:47:13.17057372 +0000 UTC",
  },
  MessageType: "PositionReport",
  Message: {
    PositionReport: {
      UserID: 367779550,
      NavigationalStatus: 0,
      Sog: 6,
      Longitude: -73.96392166666666,
      Latitude: 40.73023833333333,
      Cog: 25.1,
      TrueHeading: 26,
    },
  },
};
const classBReport = {
  MetaData: { MMSI: 338323929, ShipName: "SATARA", time_utc: "2026-09-24 16:47:15.399 +0000 UTC" },
  MessageType: "StandardClassBPositionReport",
  Message: {
    StandardClassBPositionReport: {
      UserID: 338323929,
      Cog: 360,
      Latitude: 40.41734666666667,
      Longitude: -74.03251333333333,
      Sog: 0.1,
      TrueHeading: 288,
    },
  },
};
const staticData = {
  MetaData: { MMSI: 367779550, ShipName: "SUNSET CROSSING" },
  MessageType: "ShipStaticData",
  Message: {
    ShipStaticData: {
      UserID: 367779550,
      Name: "SUNSET CROSSING     ",
      CallSign: "WDE5486@@",
      Destination: "",
      Type: 60,
    },
  },
};

describe("AISStream message parsing", () => {
  it("normalizes class A and class B position reports", () => {
    const now = Date.parse("2026-09-24T16:48:00Z");
    const a = parseAisMessage(JSON.stringify(positionReport), now);
    assert.equal(a.kind, "position");
    assert.ok(a.kind === "position");
    assert.equal(a.vessel.mmsi, "367779550");
    assert.equal(a.vessel.name, "SUNSET CROSSING");
    assert.equal(a.vessel.speedKnots, 6);
    assert.equal(a.vessel.courseDeg, 25.1);
    assert.equal(a.vessel.aisClass, "A");
    assert.equal(a.vessel.observedAtMs, Date.parse("2026-09-24T16:47:13.170Z"));

    const b = parseAisMessage(JSON.stringify(classBReport), now);
    assert.ok(b.kind === "position");
    assert.equal(b.vessel.aisClass, "B");
    // COG 360 means "not available", so the heading stands in for it.
    assert.equal(b.vessel.courseDeg, 288);
  });

  it("reads static data, confirmations and errors, and ignores junk", () => {
    const details = parseAisMessage(JSON.stringify(staticData), 0);
    assert.deepEqual(details, {
      kind: "static",
      mmsi: "367779550",
      details: {
        name: "SUNSET CROSSING",
        shipType: 60,
        callSign: "WDE5486",
        destination: undefined,
      },
    });
    assert.deepEqual(
      parseAisMessage('{"Message":{},"MessageType":"SubscriptionConfirmation"}', 0),
      { kind: "confirmed" },
    );
    assert.deepEqual(parseAisMessage('{"error":"Api Key Is Not Valid"}', 0), {
      kind: "error",
      message: "Api Key Is Not Valid",
    });
    assert.deepEqual(parseAisMessage("not json", 0), { kind: "ignored" });
    const unavailable = structuredClone(positionReport);
    unavailable.Message.PositionReport.Latitude = 91;
    assert.deepEqual(parseAisMessage(JSON.stringify(unavailable), 0), { kind: "ignored" });
  });

  it("groups AIS ship-type codes into readable categories", () => {
    assert.equal(vesselCategory(70), "Cargo");
    assert.equal(vesselCategory(84), "Tanker");
    assert.equal(vesselCategory(60), "Passenger");
    assert.equal(vesselCategory(30), "Fishing");
    assert.equal(vesselCategory(undefined), "Unknown");
  });
});

describe("AIS vessel CZML", () => {
  const now = new Date("2026-09-24T17:00:00Z");
  const vessel = (overrides: Partial<VesselObservation> = {}): VesselObservation => ({
    mmsi: "1",
    latitude: 40,
    longitude: -74,
    speedKnots: 10,
    courseDeg: 90,
    aisClass: "A",
    observedAtMs: now.getTime(),
    ...overrides,
  });

  it("dead-reckons a moving vessel and holds a moored one in place", () => {
    const result = vesselsToCzml([vessel(), vessel({ mmsi: "2", speedKnots: 0.1 })], now, 600);
    const moving = result.packets[1].position as {
      cartographicDegrees: number[];
      forwardExtrapolationType: string;
    };
    const [, lon0, lat0, , , lon1, lat1] = moving.cartographicDegrees;
    assert.ok(lon1 > lon0, "an eastbound vessel moves east");
    assert.ok(Math.abs(lat1 - lat0) < 1e-3);
    assert.equal(moving.forwardExtrapolationType, "HOLD");
    const moored = (result.packets[2].position as { cartographicDegrees: number[] })
      .cartographicDegrees;
    assert.deepEqual(moored.slice(1, 4), moored.slice(5, 8));
    assert.equal(result.attributes.features.length, 2);
  });
});

/** A socket the test drives by hand. */
class FakeSocket implements AisSocket {
  binaryType = "blob";
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: AisSocket["onopen"] = null;
  onmessage: AisSocket["onmessage"] = null;
  onclose: AisSocket["onclose"] = null;
  onerror: AisSocket["onerror"] = null;
  constructor(public url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(frame: unknown) {
    // AISStream sends JSON in binary frames.
    this.onmessage?.({ data: new TextEncoder().encode(JSON.stringify(frame)).buffer });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

describe("AISStream client", () => {
  let sockets: FakeSocket[];
  let clock: number;
  let states: AisConnectionState[];
  let client: AisStreamClient;
  const harbor: [number, number, number, number] = [-75, 40, -73, 41.5];

  beforeEach(() => {
    sockets = [];
    clock = Date.parse("2026-09-24T16:48:00Z");
    states = [];
    client = new AisStreamClient({
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      now: () => clock,
      onStateChange: (state) => states.push(state),
    });
  });
  afterEach(() => client.stop());

  it("subscribes to the view with the key and collects vessels", () => {
    client.update("key-1", harbor);
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].url, AISSTREAM_URL);
    assert.equal(sockets[0].binaryType, "arraybuffer");
    sockets[0].open();
    const subscription = JSON.parse(sockets[0].sent[0]);
    assert.equal(subscription.APIKey, "key-1");
    // AISStream wants [lat, lon] corners.
    assert.deepEqual(subscription.BoundingBoxes, [
      [
        [40, -75],
        [41.5, -73],
      ],
    ]);
    sockets[0].deliver({ MessageType: "SubscriptionConfirmation", Message: {} });
    sockets[0].deliver(positionReport);
    sockets[0].deliver(staticData);
    const snapshot = client.snapshot();
    assert.equal(snapshot.state, "live");
    assert.equal(snapshot.vessels.length, 1);
    assert.equal(snapshot.vessels[0].shipType, 60);
    assert.equal(snapshot.vessels[0].callSign, "WDE5486");
    assert.deepEqual(states, ["connecting", "live"]);
  });

  it("resubscribes on the same socket when the view moves, dropping vessels left behind", () => {
    client.update("key-1", harbor);
    sockets[0].open();
    sockets[0].deliver(positionReport);
    client.update("key-1", harbor);
    assert.equal(sockets[0].sent.length, 1, "an unchanged view is not a resubscription");
    client.update("key-1", [3.9, 51.8, 4.6, 52.1]);
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].sent.length, 2);
    assert.equal(client.snapshot().vessels.length, 0);
  });

  it("opens a new socket for a new key", () => {
    client.update("key-1", harbor);
    sockets[0].open();
    client.update("key-2", harbor);
    assert.equal(sockets[0].closed, true);
    assert.equal(sockets.length, 2);
  });

  it("treats two silent closes after subscribing as a rejected key", async () => {
    client.update("bad", harbor);
    sockets[0].open();
    sockets[0].drop();
    assert.equal(client.snapshot().state, "reconnecting");
    // Wait out the first backoff step for the reconnect.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    assert.equal(sockets.length, 2);
    sockets[1].open();
    sockets[1].drop();
    assert.equal(client.snapshot().state, "keyRejected");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sockets.length, 2, "a rejected key is not retried");
    // The same key stays rejected; a new one reconnects.
    client.update("bad", harbor);
    assert.equal(sockets.length, 2);
    client.update("good", harbor);
    assert.equal(sockets.length, 3);
  });

  it("does not blame a key that has already worked for later network drops", async () => {
    client.update("good", harbor);
    sockets[0].open();
    sockets[0].deliver({ MessageType: "SubscriptionConfirmation", Message: {} });
    // A pan resubscribes, then the network drops twice before any frame.
    client.update("good", [3.9, 51.8, 4.6, 52.1]);
    sockets[0].drop();
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    assert.equal(sockets.length, 2);
    sockets[1].open();
    sockets[1].drop();
    assert.equal(client.snapshot().state, "reconnecting");
  });

  it("does not count a reconnect that never opened as a silent rejection", async () => {
    client.update("key", harbor);
    sockets[0].open();
    sockets[0].drop();
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    // Still offline: the reconnect fails before it can subscribe.
    sockets[1].drop();
    assert.equal(client.snapshot().state, "reconnecting");
  });

  it("forgets vessels not heard from within the retention window", () => {
    client.update("key-1", harbor);
    sockets[0].open();
    sockets[0].deliver(positionReport);
    clock = Date.parse("2026-09-24T16:47:13Z") + AIS_VESSEL_TTL_MS + 1_000;
    assert.equal(client.snapshot().vessels.length, 0);
  });

  it("closes the socket and resets on stop", () => {
    client.update("key-1", harbor);
    sockets[0].open();
    client.stop();
    assert.equal(sockets[0].closed, true);
    assert.equal(client.snapshot().state, "idle");
  });
});

describe("God's Eye View API keys", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  let original: PropertyDescriptor | undefined;
  beforeEach(() => {
    values.clear();
    original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  });
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("prefers the panel's key, then falls back to the runtime environment", () => {
    const env = { VITE_TOMTOM_API_KEY: " env-key " };
    assert.deepEqual(resolveGodsEyeViewKey("tomtom", env), {
      key: "env-key",
      source: "environment",
    });
    assert.equal(writeStoredGodsEyeViewKey("tomtom", " panel-key "), true);
    assert.equal(values.get(`${GODS_EYE_VIEW_KEY_STORAGE_PREFIX}tomtom`), "panel-key");
    assert.deepEqual(resolveGodsEyeViewKey("tomtom", env), { key: "panel-key", source: "panel" });
    writeStoredGodsEyeViewKey("tomtom", "");
    assert.equal(values.size, 0);
    assert.equal(resolveGodsEyeViewKey("aisstream", {}), null);
    assert.deepEqual(resolveGodsEyeViewKey("aisstream", { AISSTREAM_API_KEY: "a" }), {
      key: "a",
      source: "environment",
    });
  });
});
