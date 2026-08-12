import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAisStreamSubscription,
  normalizeAisStreamMessage,
  parseAisStreamEvent,
} from "../packages/plugins/src/plugins/aisstream-api";
import { buildTimeBinding, buildTimeFilter } from "../packages/plugins/src/plugins/time-slider-binding";

const message = {
  MessageType: "PositionReport",
  MetaData: {
    MMSI: 123456789,
    ShipName: " TEST VESSEL ",
    latitude: 36.84,
    longitude: -76.29,
    time_utc: "2026-07-24 12:34:56.000 +0000 UTC",
  },
  Message: {
    PositionReport: {
      Cog: 92.4,
      NavigationalStatus: 0,
      Sog: 12.3,
      TrueHeading: 91,
    },
  },
};

describe("AISStream adapter", () => {
  it("builds a latitude-longitude subscription from GeoLibre bounds", () => {
    assert.deepEqual(buildAisStreamSubscription(" secret ", [-77, 36, -75, 38]), {
      APIKey: "secret",
      BoundingBoxes: [[[36, -77], [38, -75]]],
      FilterMessageTypes: [
        "PositionReport",
        "StandardClassBPositionReport",
        "ExtendedClassBPositionReport",
      ],
    });
  });

  it("normalizes a position and preserves its observation time", () => {
    const feature = normalizeAisStreamMessage(message);
    assert.ok(feature);
    assert.deepEqual(feature.geometry.coordinates, [-76.29, 36.84]);
    assert.equal(feature.properties.mmsi, 123456789);
    assert.equal(feature.properties.vessel_name, "TEST VESSEL");
    assert.equal(feature.properties.speed_knots, 12.3);
    assert.equal(feature.properties.observed_at, "2026-07-24T12:34:56.000Z");
  });

  it("rejects malformed and non-position traffic", () => {
    assert.equal(parseAisStreamEvent("not json"), null);
    assert.equal(normalizeAisStreamMessage({ ...message, MessageType: "ShipStaticData" }), null);
    assert.equal(
      normalizeAisStreamMessage({
        ...message,
        MetaData: { ...message.MetaData, latitude: 100 },
      }),
      null,
    );
  });

  it("feeds GeoLibre's existing temporal binding and filter", () => {
    const first = normalizeAisStreamMessage(message)!;
    const second = normalizeAisStreamMessage({
      ...message,
      MetaData: { ...message.MetaData, time_utc: "2026-07-24T13:34:56Z" },
    })!;
    const collection = { type: "FeatureCollection" as const, features: [first, second] };
    const binding = buildTimeBinding(collection, "observed_at", {
      unit: "hour",
      before: 1,
      after: 1,
    });
    assert.ok(binding);
    assert.equal(binding.valueKind, "isoDateTime");
    assert.equal(binding.granularity, "hour");
    assert.ok(buildTimeFilter(binding, new Date("2026-07-24T13:00:00Z")));
  });
});
