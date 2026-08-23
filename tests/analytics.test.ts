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

/** A hosted URL carrying the kind of query GeoLibre puts in its own links. */
const SENSITIVE_URL = {
  origin: "https://web.geolibre.app",
  pathname: "/",
  search: "?url=https://example.com/secret-project.geolibre.json&session=abc123",
};

/** The page that linked here, itself carrying a project in its query. */
const SENSITIVE_REFERRER =
  "https://geolibre.app/demo/?url=https://example.com/private.geolibre.json";

/** A document with the globals gtag.js seeds, as a browser page would have. */
function makeDocument() {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  // linkedom leaves `location` undefined; analytics reads origin and pathname
  // from it to build the page it reports.
  Object.defineProperty(document.defaultView, "location", {
    value: SENSITIVE_URL,
    configurable: true,
  });
  Object.defineProperty(document, "referrer", {
    value: SENSITIVE_REFERRER,
    configurable: true,
  });
  return document as unknown as Document;
}

/** The queued gtag calls, each as a plain array. */
function queue(doc: Document): unknown[][] {
  const { dataLayer } = doc.defaultView as unknown as { dataLayer: IArguments[] };
  return dataLayer.map((entry) => Array.from(entry));
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

    // The queue gtag.js drains on load: the page default, the `js` timestamp,
    // the configuration, then the one page view we send ourselves.
    const calls = queue(doc);
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["set", "js", "config", "event"],
    );
    const page = {
      page_location: "https://web.geolibre.app/",
      page_referrer: "https://geolibre.app/demo/",
    };
    assert.deepEqual(calls[2], ["config", ID, { ...page, send_page_view: false }]);
    assert.deepEqual(calls[3], ["event", "page_view", page]);

    // A second call (StrictMode's double-invoke, or dev HMR) must not stack a
    // second tag or re-queue the configuration.
    installAnalytics(ID, doc);
    assert.equal(doc.querySelectorAll("script[src*='googletagmanager']").length, 1);
    assert.equal(queue(doc).length, 4);
  });

  it("never reports the query string, of this page or the referring one", () => {
    // A GeoLibre link carries the visitor's work in its parameters (a project
    // URL, an inline dataset, a collaboration session), so nothing queued for
    // Google may contain the query, including the automatic page view that
    // `send_page_view: false` suppresses and the referrer gtag would otherwise
    // read from the document itself.
    const doc = makeDocument();
    installAnalytics(ID, doc);
    const queued = JSON.stringify(queue(doc));
    assert.ok(!queued.includes("secret-project"), queued);
    assert.ok(!queued.includes("session=abc123"), queued);
    assert.ok(!queued.includes("private.geolibre.json"), queued);
    assert.ok(!queued.includes("?"), queued);
    for (const call of queue(doc)) {
      if (call[0] === "config")
        assert.equal((call[2] as Record<string, unknown>).send_page_view, false);
    }
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
