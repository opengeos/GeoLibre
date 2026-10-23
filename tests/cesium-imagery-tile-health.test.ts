import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ImageryProvider } from "@cesium/engine";
import {
  MAX_REPORTED_TILE_FAILURES,
  watchImageryTileHealth,
  type ImageryTileFailure,
} from "../packages/map/src/cesium-imagery-tile-health";

/** A minimal Cesium.Event stand-in: addEventListener returns its remover. */
class FakeEvent {
  listeners = new Set<(value: unknown) => void>();
  addEventListener(listener: (value: unknown) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  raise(value: unknown) {
    for (const listener of this.listeners) listener(value);
  }
}

class FakeProvider {
  errorEvent = new FakeEvent();
  next: Promise<unknown> | undefined = Promise.resolve({});
  requestImage() {
    return this.next;
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const asProvider = (fake: FakeProvider) => fake as unknown as ImageryProvider;
const tileError = (error?: unknown) => ({ level: 3, x: 1, y: 2, message: "Failed", error });

describe("watchImageryTileHealth", () => {
  it("counts loaded tiles and reports each failure with the tallies", async () => {
    const fake = new FakeProvider();
    const failures: ImageryTileFailure[] = [];
    watchImageryTileHealth(asProvider(fake), (failure) => failures.push(failure));
    await asProvider(fake).requestImage(0, 0, 0);
    await asProvider(fake).requestImage(1, 0, 0);
    await flush();
    fake.errorEvent.raise(tileError({ statusCode: 403 }));
    fake.errorEvent.raise(tileError(new Event("error")));
    assert.deepEqual(
      failures.map(({ status, loaded, failed }) => ({ status, loaded, failed })),
      [
        { status: 403, loaded: 2, failed: 1 },
        { status: undefined, loaded: 2, failed: 2 },
      ],
    );
  });

  it("does not count a throttled request or an empty result as loaded", async () => {
    const fake = new FakeProvider();
    const failures: ImageryTileFailure[] = [];
    watchImageryTileHealth(asProvider(fake), (failure) => failures.push(failure));
    fake.next = undefined;
    asProvider(fake).requestImage(0, 0, 0);
    fake.next = Promise.resolve(undefined);
    await asProvider(fake).requestImage(0, 0, 0);
    await flush();
    fake.errorEvent.raise(tileError());
    assert.equal(failures[0].loaded, 0);
  });

  it("ignores provider-wide errors and caps the reports", () => {
    const fake = new FakeProvider();
    const failures: ImageryTileFailure[] = [];
    watchImageryTileHealth(asProvider(fake), (failure) => failures.push(failure));
    fake.errorEvent.raise({ message: "provider" });
    for (let i = 0; i < MAX_REPORTED_TILE_FAILURES + 10; i++) fake.errorEvent.raise(tileError());
    assert.equal(failures.length, MAX_REPORTED_TILE_FAILURES);
  });

  it("restores the provider and stops reporting once stopped", () => {
    const fake = new FakeProvider();
    const failures: ImageryTileFailure[] = [];
    const stop = watchImageryTileHealth(asProvider(fake), (failure) => failures.push(failure));
    assert.ok(Object.prototype.hasOwnProperty.call(fake, "requestImage"));
    stop();
    assert.ok(!Object.prototype.hasOwnProperty.call(fake, "requestImage"));
    assert.equal(fake.errorEvent.listeners.size, 0);
    fake.errorEvent.raise(tileError());
    assert.equal(failures.length, 0);
  });
});
