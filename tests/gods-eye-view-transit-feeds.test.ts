import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ENTUR_CLIENT_NAME,
  ENTUR_TRANSIT_URL,
  decodeGtfsRealtimeVehicles,
  fetchTransitCzml,
  transitVehiclesToCzml,
  type TransitVehicle,
} from "../packages/plugins/src/plugins/gods-eye-view-transit-feeds";

interface FixtureVehicle {
  entityId: string;
  vehicleId?: string;
  label?: string;
  routeId?: string;
  tripId?: string;
  latitude: number;
  longitude: number;
  bearing?: number;
  speed?: number;
  timestamp?: number;
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 127) {
    bytes.push((remaining % 128) | 128);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return bytes;
}

function field(tag: number, wire: number, bytes: readonly number[]): number[] {
  return [...varint(tag * 8 + wire), ...bytes];
}

function stringField(tag: number, value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return field(tag, 2, [...varint(bytes.length), ...bytes]);
}

function floatField(tag: number, value: number): number[] {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, true);
  return field(tag, 5, [...bytes]);
}

function messageField(tag: number, bytes: readonly number[]): number[] {
  return field(tag, 2, [...varint(bytes.length), ...bytes]);
}

function encodeFeed(vehicles: FixtureVehicle[]): Uint8Array {
  const header = [...stringField(1, "2.0"), ...field(3, 0, varint(1_795_000_000))];
  const bytes = [...messageField(1, header)];
  for (const vehicle of vehicles) {
    const trip = [
      ...(vehicle.tripId ? stringField(1, vehicle.tripId) : []),
      ...(vehicle.routeId ? stringField(5, vehicle.routeId) : []),
    ];
    const position = [
      ...floatField(1, vehicle.latitude),
      ...floatField(2, vehicle.longitude),
      ...(vehicle.bearing !== undefined ? floatField(3, vehicle.bearing) : []),
      ...(vehicle.speed !== undefined ? floatField(5, vehicle.speed) : []),
    ];
    const descriptor = [
      ...(vehicle.vehicleId ? stringField(1, vehicle.vehicleId) : []),
      ...(vehicle.label ? stringField(2, vehicle.label) : []),
    ];
    const vehiclePosition = [
      ...messageField(1, trip),
      ...messageField(2, position),
      ...(vehicle.timestamp !== undefined ? field(5, 0, varint(vehicle.timestamp)) : []),
      ...messageField(8, descriptor),
    ];
    const entity = [...stringField(1, vehicle.entityId), ...messageField(4, vehiclePosition)];
    bytes.push(...messageField(2, entity));
  }
  return new Uint8Array(bytes);
}

const bus: TransitVehicle = {
  id: "bus-1",
  longitude: 10.75,
  latitude: 59.91,
  bearing: 90,
  speedMps: 10,
  observedAtMs: Date.parse("2026-09-20T12:00:00Z"),
  routeId: "RUT:Line:31",
  tripId: "trip-1",
  label: "31",
  stopId: null,
  mode: "bus",
};

describe("God's Eye View transit feed", () => {
  it("decodes and normalizes GTFS-Realtime VehiclePositions", () => {
    const decoded = decodeGtfsRealtimeVehicles(
      encodeFeed([
        {
          entityId: "entity-1",
          vehicleId: "vehicle-1",
          label: "R31",
          routeId: "RUT:Line:31",
          tripId: "trip-1",
          latitude: 59.91,
          longitude: 10.75,
          bearing: 450,
          speed: 12.5,
          timestamp: 1_795_000_001,
        },
        {
          entityId: "null-island",
          latitude: 0,
          longitude: 0,
        },
      ]),
    );

    assert.equal(decoded.version, "2.0");
    assert.equal(decoded.timestampMs, 1_795_000_000_000);
    assert.equal(decoded.entityCount, 2);
    assert.equal(decoded.vehicles.length, 1);
    assert.deepEqual(decoded.vehicles[0], {
      id: "vehicle-1",
      longitude: 10.75,
      latitude: 59.90999984741211,
      bearing: 90,
      speedMps: 12.5,
      observedAtMs: 1_795_000_001_000,
      routeId: "RUT:Line:31",
      tripId: "trip-1",
      label: "R31",
      stopId: null,
      mode: "bus",
    });
  });

  it("classifies known Entur rail codes and keeps the newest duplicate vehicle", () => {
    const decoded = decodeGtfsRealtimeVehicles(
      encodeFeed([
        {
          entityId: "old",
          vehicleId: "train-1",
          routeId: "VYG:Line:F4",
          latitude: 60,
          longitude: 11,
          timestamp: 100,
        },
        {
          entityId: "new",
          vehicleId: "train-1",
          routeId: "VYG:Line:F4",
          latitude: 61,
          longitude: 12,
          timestamp: 200,
        },
      ]),
    );
    assert.equal(decoded.vehicles.length, 1);
    assert.equal(decoded.vehicles[0].latitude, 61);
    assert.equal(decoded.vehicles[0].mode, "rail");
  });

  it("creates short interpolated CZML paths and table attributes", () => {
    const now = new Date("2026-09-20T12:00:10Z");
    const payload = transitVehiclesToCzml([bus], now);
    assert.equal(payload.packets.length, 2);
    assert.equal(payload.attributes.features.length, 1);
    assert.equal(payload.attributes.features[0].properties?.operator, "Entur");
    const samples = (payload.packets[1].position as { cartographicDegrees: number[] })
      .cartographicDegrees;
    assert.deepEqual(
      samples.filter((_, index) => index % 4 === 0),
      [0, 45],
    );
    assert.ok(samples[5] > samples[1]);
  });

  it("identifies GeoLibre when fetching Entur", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(encodeFeed([]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }) as typeof fetch;

    const payload = await fetchTransitCzml({
      fetch: fetcher,
      now: new Date("2026-09-20T12:00:00Z"),
    });
    assert.equal(payload.attributes.features.length, 0);
    assert.equal(calls[0].url, ENTUR_TRANSIT_URL);
    assert.equal(new Headers(calls[0].init?.headers).get("ET-Client-Name"), ENTUR_CLIENT_NAME);
  });
});
