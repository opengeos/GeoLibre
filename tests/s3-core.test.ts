import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  encodeS3Key,
  explainS3ReadError,
  isCredentialedS3Url,
  parseS3Error,
  parseS3ListObjects,
  parseS3Url,
  presignS3Url,
  registerS3UrlSigner,
  resolveReadableUrl,
  s3ObjectHttpsUrl,
  unsignedSourceUrl,
} from "../packages/core/src/s3";

describe("parseS3Url", () => {
  it("parses s3:// URIs with raw keys", () => {
    assert.deepEqual(parseS3Url("s3://bucket/dir/my file.tif"), {
      bucket: "bucket",
      key: "dir/my file.tif",
    });
    assert.deepEqual(parseS3Url("s3a://bucket"), { bucket: "bucket", key: "" });
    assert.equal(parseS3Url("s3://"), null);
    // A bucket that could rewrite a virtual-hosted URL's authority.
    assert.equal(parseS3Url("s3://evil.com\\x/key"), null);
    assert.equal(parseS3Url("s3://user@evil.com/key"), null);
  });

  it("parses virtual-hosted and path-style AWS URLs, dropping the query", () => {
    assert.deepEqual(parseS3Url("https://b.s3.amazonaws.com/a%20b.tif?X-Amz-Signature=x"), {
      bucket: "b",
      key: "a b.tif",
    });
    assert.deepEqual(parseS3Url("https://b.s3.us-west-2.amazonaws.com/k"), {
      bucket: "b",
      key: "k",
      region: "us-west-2",
    });
    assert.deepEqual(parseS3Url("https://my.bucket.s3-eu-west-1.amazonaws.com/k"), {
      bucket: "my.bucket",
      key: "k",
      region: "eu-west-1",
    });
    assert.deepEqual(parseS3Url("https://s3.ap-south-1.amazonaws.com/b/x/y.parquet"), {
      bucket: "b",
      key: "x/y.parquet",
      region: "ap-south-1",
    });
    assert.deepEqual(parseS3Url("https://b.s3.dualstack.us-east-2.amazonaws.com/k"), {
      bucket: "b",
      key: "k",
      region: "us-east-2",
    });
  });

  it("rejects non-S3 and website endpoints", () => {
    assert.equal(parseS3Url("https://example.com/a.tif"), null);
    assert.equal(parseS3Url("https://b.s3-website-us-west-2.amazonaws.com/index.html"), null);
    assert.equal(parseS3Url("gs://bucket/key"), null);
    assert.equal(parseS3Url("not a url"), null);
  });
});

describe("s3ObjectHttpsUrl", () => {
  it("builds regional virtual-hosted URLs and encodes keys once", () => {
    assert.equal(
      s3ObjectHttpsUrl({ bucket: "b", key: "a b/c+d.tif" }, { region: "us-west-2" }),
      "https://b.s3.us-west-2.amazonaws.com/a%20b/c%2Bd.tif",
    );
    assert.equal(s3ObjectHttpsUrl({ bucket: "b", key: "k" }), "https://b.s3.amazonaws.com/k");
  });

  it("uses path style for dotted buckets and custom endpoints when asked", () => {
    assert.equal(
      s3ObjectHttpsUrl({ bucket: "my.bucket", key: "k" }, { region: "us-east-1" }),
      "https://s3.amazonaws.com/my.bucket/k",
    );
    assert.equal(
      s3ObjectHttpsUrl(
        { bucket: "b", key: "k" },
        { region: "auto", endpoint: "http://localhost:9000/", pathStyle: true },
      ),
      "http://localhost:9000/b/k",
    );
    assert.equal(
      s3ObjectHttpsUrl({ bucket: "b", key: "k" }, { region: "auto", endpoint: "r2.example.com" }),
      "https://b.r2.example.com/k",
    );
    assert.equal(
      s3ObjectHttpsUrl(
        { bucket: "bkt", key: "k" },
        { endpoint: "https://gw.test/s3/", pathStyle: true },
      ),
      "https://gw.test/s3/bkt/k",
    );
  });

  it("refuses bucket names that could change the URL's host", () => {
    assert.throws(() =>
      s3ObjectHttpsUrl({ bucket: "a\\b", key: "k" }, { endpoint: "https://x.test" }),
    );
    assert.throws(() => s3ObjectHttpsUrl({ bucket: "a@b", key: "k" }));
  });

  it("encodes reserved characters SigV4 treats as unreserved-only", () => {
    assert.equal(encodeS3Key("a(1)!*'.tif"), "a%281%29%21%2A%27.tif");
  });
});

describe("presignS3Url", () => {
  it("matches the AWS documentation example", async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = await presignS3Url({
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      expiresIn: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    assert.equal(
      url,
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("signs the session token and clamps the lifetime", async () => {
    const url = new URL(
      await presignS3Url({
        url: "https://b.s3.amazonaws.com/k",
        region: "us-east-1",
        credentials: { accessKeyId: "A", secretAccessKey: "S", sessionToken: "T/+=" },
        expiresIn: 10 * 24 * 3600,
      }),
    );
    assert.equal(url.searchParams.get("X-Amz-Security-Token"), "T/+=");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "604800");
  });
});

describe("signer registry", () => {
  afterEach(() => registerS3UrlSigner(null));

  it("reads uncovered s3:// URIs anonymously and leaves other URLs alone", async () => {
    assert.equal(await resolveReadableUrl("s3://pub/k.tif"), "https://pub.s3.amazonaws.com/k.tif");
    assert.equal(await resolveReadableUrl("https://x.test/a.tif"), "https://x.test/a.tif");
    assert.equal(isCredentialedS3Url("s3://pub/k.tif"), false);
  });

  it("signs covered buckets and maps the signed URL back to its source", async () => {
    registerS3UrlSigner({
      covers: (bucket) => bucket === "private",
      connections: () => [],
      presign: async (location) => ({
        href: `https://private.s3.amazonaws.com/${location.key}?X-Amz-Signature=abc`,
        expiresAt: Date.now() + 60_000,
      }),
    });
    assert.equal(isCredentialedS3Url("s3://private/a.tif"), true);
    assert.equal(isCredentialedS3Url("https://private.s3.amazonaws.com/a.tif"), true);
    const href = await resolveReadableUrl("s3://private/a.tif");
    assert.equal(href, "https://private.s3.amazonaws.com/a.tif?X-Amz-Signature=abc");
    assert.equal(unsignedSourceUrl(href), "s3://private/a.tif");
    assert.equal(unsignedSourceUrl("https://other.test/x"), "https://other.test/x");
  });

  it("never returns a signature for a presigned URL it does not know", () => {
    assert.equal(
      unsignedSourceUrl(
        "https://evicted.s3.us-west-2.amazonaws.com/a%20b.tif?X-Amz-Credential=K&X-Amz-Security-Token=T&X-Amz-Signature=S",
      ),
      "s3://evicted/a b.tif",
    );
    assert.equal(
      unsignedSourceUrl("https://minio.test/bkt/k?v=1&X-Amz-Security-Token=T&X-Amz-Signature=S"),
      "https://minio.test/bkt/k?v=1",
    );
    // Keys an s3:// URI cannot hold keep the object URL form.
    for (const key of ["a%23b.tif", "a%3Fb.tif"]) {
      assert.equal(
        unsignedSourceUrl(`https://bkt.s3.amazonaws.com/${key}?X-Amz-Signature=S`),
        `https://bkt.s3.amazonaws.com/${key}`,
      );
    }
  });
});

describe("ListObjectsV2 parsing", () => {
  it("reads prefixes, objects, and the continuation token", () => {
    const page = parseS3ListObjects(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><Prefix>test/</Prefix>
<NextContinuationToken>1ab=</NextContinuationToken><KeyCount>3</KeyCount><IsTruncated>true</IsTruncated>
<Contents><Key>test/a &amp; b.tif</Key><LastModified>2026-09-30T19:59:00.000Z</LastModified><Size>6004315</Size></Contents>
<Contents><Key>test/c.parquet</Key><Size>10</Size></Contents>
<CommonPrefixes><Prefix>test/sub/</Prefix></CommonPrefixes></ListBucketResult>`);
    assert.deepEqual(page, {
      prefixes: ["test/sub/"],
      objects: [
        { key: "test/a & b.tif", size: 6004315, lastModified: "2026-09-30T19:59:00.000Z" },
        { key: "test/c.parquet", size: 10 },
      ],
      nextContinuationToken: "1ab=",
    });
  });

  it("reads S3 error bodies with the expected region", () => {
    assert.deepEqual(
      parseS3Error(
        "<Error><Code>AuthorizationHeaderMalformed</Code><Message>wrong region</Message><Region>us-west-2</Region></Error>",
      ),
      { code: "AuthorizationHeaderMalformed", message: "wrong region", region: "us-west-2" },
    );
    assert.equal(parseS3Error("<ListBucketResult/>"), null);
  });
});

describe("explainS3ReadError", () => {
  it("leaves errors that are not network failures of S3 reads alone", async () => {
    const parseError = new Error("Not a valid TIFF");
    assert.equal(await explainS3ReadError("s3://bkt/a.tif", parseError), parseError);
    const offSite = new TypeError("Failed to fetch");
    assert.equal(await explainS3ReadError("https://example.com/a.tif", offSite), offSite);
  });
});
