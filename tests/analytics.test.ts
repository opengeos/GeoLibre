import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { parseHTML } from "linkedom";
import {
  GA_MEASUREMENT_ID_ENV,
  installAnalytics,
  resolveAnalyticsId,
  startAnalytics,
} from "../apps/geolibre-desktop/src/lib/analytics";

const ID = "G-ABC1234567";

/** A document with the globals gtag.js seeds, as a browser page would have. */
function makeDocument() {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  return document as unknown as Document;
}

/** The GA script tag installed into `doc`, if any. */
function tag(doc: Document): HTMLScriptElement | null {
  return doc.querySelector("script[src*='googletagmanager']");
}

describe("analytics configuration", () => {
  it("stays off when no measurement ID is configured", () => {
    assert.equal(resolveAnalyticsId(true, {}, {}), undefined);
    assert.equal(resolveAnalyticsId(true, { [GA_MEASUREMENT_ID_ENV]: "  " }, {}), undefined);
  });

  it("reads the measurement ID from either env tier", () => {
    assert.equal(resolveAnalyticsId(true, { [GA_MEASUREMENT_ID_ENV]: ID }, {}), ID);
    assert.equal(resolveAnalyticsId(true, {}, { [GA_MEASUREMENT_ID_ENV]: ID }), ID);
  });

  it("normalizes a lowercased measurement ID", () => {
    assert.equal(resolveAnalyticsId(true, { [GA_MEASUREMENT_ID_ENV]: ID.toLowerCase() }, {}), ID);
  });

  it("refuses a value that is not a GA4 measurement ID", () => {
    const error = mock.method(console, "error", () => {});
    try {
      // A Universal Analytics property, a tag manager container, and a value
      // that would smuggle a query parameter into the script URL.
      for (const value of ["UA-12345-1", "GTM-ABCD123", "G-ABC1234567&x=1"]) {
        assert.equal(resolveAnalyticsId(true, { [GA_MEASUREMENT_ID_ENV]: value }, {}), undefined);
      }
      assert.equal(error.mock.callCount(), 3);
    } finally {
      error.mock.restore();
    }
  });

  it("stays off outside the hosted web build even when configured", () => {
    // The desktop shell and the Jupyter embed wheel pass webApp: false, so a
    // measurement ID left in the build environment must not load a tracker.
    assert.equal(resolveAnalyticsId(false, { [GA_MEASUREMENT_ID_ENV]: ID }, {}), undefined);
  });
});

describe("analytics installation", () => {
  it("seeds dataLayer and appends the tag once", () => {
    const doc = makeDocument();
    installAnalytics(ID, doc);

    const script = tag(doc);
    assert.ok(script, "gtag.js was not appended");
    assert.equal(script.src, `https://www.googletagmanager.com/gtag/js?id=${ID}`);
    assert.equal(script.async, true);

    const { dataLayer } = doc.defaultView as unknown as { dataLayer: IArguments[] };
    // The queue gtag.js drains on load: the `js` timestamp, then `config`.
    assert.deepEqual(
      dataLayer.map((entry) => Array.from(entry)[0]),
      ["js", "config"],
    );
    assert.deepEqual(Array.from(dataLayer[1]), ["config", ID]);

    // A second call (StrictMode's double-invoke, or dev HMR) must not stack a
    // second tag or re-queue the configuration.
    installAnalytics(ID, doc);
    assert.equal(doc.querySelectorAll("script[src*='googletagmanager']").length, 1);
    assert.equal(dataLayer.length, 2);
  });
});

describe("analytics startup", () => {
  /** Run `body` with a document in scope, as the browser entry point has. */
  function withDocument(body: (doc: Document) => void) {
    const doc = makeDocument();
    const globals = globalThis as { document?: Document };
    const previous = globals.document;
    globals.document = doc;
    try {
      body(doc);
    } finally {
      if (previous) globals.document = previous;
      else delete globals.document;
    }
  }

  it("installs the tag for a configured hosted web build", () => {
    withDocument((doc) => {
      assert.equal(startAnalytics(true, { [GA_MEASUREMENT_ID_ENV]: ID }, {}), ID);
      assert.ok(tag(doc));
    });
  });

  it("installs nothing when analytics are not configured", () => {
    withDocument((doc) => {
      assert.equal(startAnalytics(true, {}, {}), undefined);
      assert.equal(tag(doc), null);
    });
  });
});
