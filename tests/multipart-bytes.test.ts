import assert from "node:assert/strict";
import { test } from "node:test";
import { multipartBytes } from "../apps/geolibre-desktop/src/lib/multipart-bytes";

test("multipart scanning preserves every byte and ignores boundary-like binary content", () => {
  const payload = Buffer.concat([
    Buffer.from([0, 255, 128, 0]),
    Buffer.from("\r\n--boundary-not-a-delimiter\r\n"),
    Buffer.from([255, 0]),
  ]);
  const message = Buffer.concat([
    Buffer.from(
      "preamble\r\n--boundary \t\r\nContent-ID: bytes\r\nContent-Type: application/octet-stream\r\n\r\n",
    ),
    payload,
    Buffer.from("\r\n--boundary-- \t\r\nepilogue"),
  ]);
  const parts = multipartBytes(message, "boundary");
  assert.equal(parts.length, 1);
  assert.equal(parts[0].headers.get("content-id"), "bytes");
  assert.deepEqual(parts[0].body, payload);
  assert.equal(parts[0].body.buffer, message.buffer, "payloads must remain byte views");
});

test("empty parts and LF framing are retained, and malformed or excessive framing fails", () => {
  const wire = Buffer.from("--b\nContent-ID: empty\n\n\n--b\n\nvalue\n--b--");
  const parts = multipartBytes(wire);
  assert.equal(parts[0].body.length, 0);
  assert.equal(new TextDecoder().decode(parts[1].body), "value");
  assert.throws(() => multipartBytes(wire, "b", 1), /multipart/);
  assert.throws(() => multipartBytes(wire.subarray(0, wire.length - 3)), /multipart/);
  assert.throws(
    () =>
      multipartBytes(Buffer.from("--b\r\nContent-ID: one\r\nContent-ID: two\r\n\r\nx\r\n--b--")),
    /multipart/,
  );
  assert.throws(
    () => multipartBytes(Buffer.from("--b\r\nX-Long: " + "a".repeat(17000) + "\r\n\r\nx\r\n--b--")),
    /multipart/,
  );
});
