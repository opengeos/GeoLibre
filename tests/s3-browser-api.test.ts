import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { S3UrlSigner } from "../packages/core/src/s3";
import {
  createS3BrowserClient,
  describeObjects,
  formatS3BrowseLocation,
  parentPrefix,
  parseS3BrowseLocation,
  prefixLabel,
} from "../packages/plugins/src/plugins/s3-browser-api";

const LISTING = `<ListBucketResult><IsTruncated>false</IsTruncated>
<Contents><Key>data/</Key><Size>0</Size></Contents>
<Contents><Key>data/dem.tif</Key><Size>100</Size></Contents>
<Contents><Key>data/notes.txt</Key><Size>5</Size></Contents>
<Contents><Key>data/autzen.copc.laz</Key><Size>9</Size></Contents>
<CommonPrefixes><Prefix>data/sub/</Prefix></CommonPrefixes></ListBucketResult>`;

describe("S3 browser locations", () => {
  it("parses typed locations in every form", () => {
    assert.deepEqual(parseS3BrowseLocation("s3://bkt/data/"), { bucket: "bkt", prefix: "data/" });
    assert.deepEqual(parseS3BrowseLocation("bkt"), { bucket: "bkt", prefix: "" });
    assert.deepEqual(parseS3BrowseLocation("https://bkt.s3.us-west-2.amazonaws.com/x/"), {
      bucket: "bkt",
      prefix: "x/",
    });
    assert.equal(parseS3BrowseLocation(""), null);
    assert.equal(parseS3BrowseLocation("https://example.com/x"), null);
    assert.equal(formatS3BrowseLocation({ bucket: "b", prefix: "x/" }), "s3://b/x/");
  });

  it("walks up folders and labels prefixes", () => {
    assert.equal(parentPrefix("a/b/"), "a/");
    assert.equal(parentPrefix("a/"), "");
    assert.equal(parentPrefix(""), "");
    assert.equal(prefixLabel("a/b/"), "b");
  });
});

describe("S3 browser client", () => {
  it("signs listings of covered buckets", async () => {
    const requests: string[] = [];
    const signer: S3UrlSigner = {
      covers: (bucket) => bucket === "b",
      connections: () => [],
      presign: async ({ query }) => ({
        href: `https://b.s3.amazonaws.com/?${new URLSearchParams(query)}&X-Amz-Signature=s`,
        expiresAt: Infinity,
      }),
      fetchText: async (url) => {
        requests.push(url);
        return { status: 200, body: LISTING };
      },
    };
    const client = createS3BrowserClient(signer, async () => {
      throw new Error("fallback fetch must not be used");
    });
    const location = { bucket: "b", prefix: "data/" };
    const page = await client.list(location);
    assert.match(requests[0], /list-type=2.*delimiter=%2F.*prefix=data%2F.*X-Amz-Signature/);
    assert.deepEqual(page.prefixes, ["data/sub/"]);
    const objects = describeObjects(location, page);
    assert.deepEqual(
      objects.map((object) => [object.name, object.format, object.pointCloud, object.uri]),
      [
        ["dem.tif", "cog", false, "s3://b/data/dem.tif"],
        ["notes.txt", "other", false, "s3://b/data/notes.txt"],
        ["autzen.copc.laz", "other", true, "s3://b/data/autzen.copc.laz"],
      ],
    );
  });

  it("follows an anonymous listing to the bucket's region once", async () => {
    const requests: string[] = [];
    const client = createS3BrowserClient(null, async (url) => {
      requests.push(url);
      return requests.length === 1
        ? {
            status: 301,
            body: "<Error><Code>PermanentRedirect</Code><Endpoint>open.s3.us-west-2.amazonaws.com</Endpoint></Error>",
          }
        : { status: 200, body: LISTING };
    });
    await client.list({ bucket: "open", prefix: "" });
    assert.equal(requests.length, 2);
    assert.match(requests[0], /^https:\/\/open\.s3\.amazonaws\.com\//);
    assert.match(requests[1], /^https:\/\/open\.s3\.us-west-2\.amazonaws\.com\//);
  });

  it("reports S3's error code", async () => {
    const client = createS3BrowserClient(null, async () => ({
      status: 403,
      body: "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>",
    }));
    await assert.rejects(
      client.list({ bucket: "closed", prefix: "" }),
      /AccessDenied: Access Denied/,
    );
  });
});
