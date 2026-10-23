import assert from "node:assert/strict";
import { it } from "node:test";
import {
  ensureGeneratedImageHandler,
  registerGeneratedImage,
  type GeneratedImageResult,
} from "../packages/map/src/generated-images";

it("resolves generated patterns before MapLibre collects the requested images", async () => {
  let resolveMissing: ((id: string) => void | Promise<void>) | undefined;
  let installations = 0;
  const images = new Map<string, unknown>();
  const map = {
    on() {},
    hasImage: (id: string) => images.has(id),
    addImage: (id: string, image: unknown) => images.set(id, image),
    setMissingStyleImageResolver(resolver: typeof resolveMissing) {
      installations += 1;
      resolveMissing = resolver;
    },
  };
  const result: GeneratedImageResult = {
    image: { width: 1, height: 1, data: new Uint8Array([0, 249, 0, 255]) },
    pixelRatio: 1,
  };
  registerGeneratedImage("test-url-pattern-builtin", () => result);
  let finishSvg!: (value: GeneratedImageResult) => void;
  registerGeneratedImage(
    "test-url-pattern-svg",
    () =>
      new Promise((resolve) => {
        finishSvg = resolve;
      }),
  );
  ensureGeneratedImageHandler(map as never);
  ensureGeneratedImageHandler(map as never);
  assert.equal(installations, 1);
  assert.ok(resolveMissing);
  await resolveMissing("unregistered-basemap-image");
  assert.equal(images.has("unregistered-basemap-image"), false);
  await resolveMissing("test-url-pattern-builtin");
  assert.equal(images.get("test-url-pattern-builtin"), result.image);
  const svgReady = resolveMissing("test-url-pattern-svg");
  assert.ok(svgReady instanceof Promise, "MapLibre must be able to await SVG rasterization");
  assert.equal(images.has("test-url-pattern-svg"), false);
  finishSvg(result);
  await svgReady;
  assert.equal(images.get("test-url-pattern-svg"), result.image);
});

it("keeps the event-based image path for older GL engines", () => {
  let missing: ((event: { id: string }) => void) | undefined;
  let calls = 0;
  let imageOptions: unknown;
  const images = new Map<string, unknown>();
  const map = {
    on: (_event: string, handler: typeof missing) => {
      missing = handler;
    },
    hasImage: (id: string) => images.has(id),
    addImage: (id: string, image: unknown, options: unknown) => {
      images.set(id, image);
      imageOptions = options;
    },
  };
  const image = { width: 1, height: 1, data: new Uint8Array([0, 249, 0, 255]) };
  registerGeneratedImage("test-legacy-pattern", () => {
    calls += 1;
    return { image, pixelRatio: 2 };
  });
  ensureGeneratedImageHandler(map as never);
  assert.ok(missing);
  missing({ id: "test-legacy-pattern" });
  missing({ id: "test-legacy-pattern" });
  assert.equal(calls, 1);
  assert.equal(images.get("test-legacy-pattern"), image);
  assert.deepEqual(imageOptions, { pixelRatio: 2 });
});

it("resolves failed asynchronous factories to a transparent fallback", async () => {
  let resolveMissing: ((id: string) => void | Promise<void>) | undefined;
  const images = new Map<string, unknown>();
  const map = {
    on() {},
    hasImage: (id: string) => images.has(id),
    addImage: (id: string, image: unknown) => images.set(id, image),
    setMissingStyleImageResolver: (resolver: typeof resolveMissing) => {
      resolveMissing = resolver;
    },
  };
  registerGeneratedImage("test-rejected-svg", () => Promise.reject(new Error("invalid SVG")));
  registerGeneratedImage("test-empty-svg", () => Promise.resolve(null));
  ensureGeneratedImageHandler(map as never);
  assert.ok(resolveMissing);
  for (const id of ["test-rejected-svg", "test-empty-svg"]) {
    await resolveMissing(id);
    assert.deepEqual(images.get(id), { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) });
  }
});

it("hands non-generated ids to a resolver installed before GeoLibre's", async () => {
  const requested: string[] = [];
  let resolveMissing: ((id: string) => void | Promise<void>) | undefined;
  const images = new Map<string, unknown>();
  const map = {
    on() {},
    hasImage: (id: string) => images.has(id),
    addImage: (id: string, image: unknown) => images.set(id, image),
    _missingStyleImageResolver: (id: string) => {
      requested.push(id);
    },
    setMissingStyleImageResolver(resolver: typeof resolveMissing) {
      resolveMissing = resolver;
    },
  };
  const image = { width: 1, height: 1, data: new Uint8Array([0, 249, 0, 255]) };
  registerGeneratedImage("test-chained-pattern", () => ({ image, pixelRatio: 1 }));
  ensureGeneratedImageHandler(map as never);
  assert.ok(resolveMissing);
  await resolveMissing("app-custom-icon");
  assert.deepEqual(requested, ["app-custom-icon"]);
  await resolveMissing("test-chained-pattern");
  assert.deepEqual(requested, ["app-custom-icon"]);
  assert.equal(images.get("test-chained-pattern"), image);
});
