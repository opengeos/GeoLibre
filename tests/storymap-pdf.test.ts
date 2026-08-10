import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildStoryMapHandoutPdf,
  hexToRgb,
  htmlToPlainText,
  type HandoutChapter,
  type HandoutOptions,
} from "../apps/geolibre-desktop/src/lib/storymap-pdf";

/** Default handout options with empty running text, overridable per test. */
function opts(overrides: Partial<HandoutOptions> = {}): HandoutOptions {
  return {
    paperSize: "a4",
    orientation: "landscape",
    title: "",
    subtitle: "",
    byline: "",
    footer: "",
    ...overrides,
  };
}

// A valid 2x2 RGB PNG, enough for jsPDF to embed without a DOM canvas.
const PNG_2X2 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=";

function chapter(overrides: Partial<HandoutChapter> = {}): HandoutChapter {
  return {
    title: "Chapter",
    description: "Some text",
    map: { data: PNG_2X2, width: 800, height: 600 },
    ...overrides,
  };
}

describe("htmlToPlainText", () => {
  it("strips tags and decodes common entities", () => {
    assert.equal(
      htmlToPlainText("<p>Hello <strong>world</strong> &amp; more</p>"),
      "Hello world & more",
    );
  });

  it("turns block tags and <br> into line breaks", () => {
    assert.equal(htmlToPlainText("<p>One</p><p>Two</p>line<br>break"), "One\nTwo\nline\nbreak");
  });

  it("collapses runs of whitespace", () => {
    assert.equal(htmlToPlainText("a   b\t c"), "a b c");
  });

  it("decodes extended named and numeric entities", () => {
    assert.equal(
      htmlToPlainText("a&mdash;b &hellip; &ldquo;q&rdquo; &#163;5 &#x41;"),
      "a—b … “q” £5 A",
    );
  });

  it("leaves unknown entities untouched", () => {
    assert.equal(htmlToPlainText("&unknownentity;"), "&unknownentity;");
  });

  it("leaves out-of-range numeric entities untouched without throwing", () => {
    assert.equal(htmlToPlainText("&#99999999; ok"), "&#99999999; ok");
  });

  it("leaves a null-byte entity (&#0;) untouched", () => {
    const out = htmlToPlainText("a&#0;b");
    assert.equal(out, "a&#0;b");
    assert.ok(!out.includes("\0"));
  });

  it("drops <script>/<style> blocks with their contents", () => {
    assert.equal(
      htmlToPlainText("<style>body{color:red}</style>Hello<script>x=1</script>"),
      "Hello",
    );
  });

  it("strips tags with a '>' inside a quoted attribute value", () => {
    assert.equal(htmlToPlainText('<span title="a > b">text</span>'), "text");
  });
});

describe("hexToRgb", () => {
  it("parses six- and three-digit hex, with or without the hash", () => {
    assert.deepEqual(hexToRgb("#3fb1ce"), [0x3f, 0xb1, 0xce]);
    assert.deepEqual(hexToRgb("3FB1CE"), [0x3f, 0xb1, 0xce]);
    assert.deepEqual(hexToRgb("#f80"), [0xff, 0x88, 0x00]);
  });

  it("falls back to the default marker blue for anything it cannot parse", () => {
    assert.deepEqual(hexToRgb("rgb(1,2,3)"), [0x3f, 0xb1, 0xce]);
    assert.deepEqual(hexToRgb(""), [0x3f, 0xb1, 0xce]);
  });
});

describe("buildStoryMapHandoutPdf", () => {
  it("produces a valid PDF byte stream", () => {
    const bytes = buildStoryMapHandoutPdf(
      [chapter()],
      opts({ title: "My Story", footer: "Footer" }),
    );
    assert.ok(bytes instanceof Uint8Array);
    assert.ok(bytes.length > 0);
    // Every PDF starts with the "%PDF" magic header.
    const header = String.fromCharCode(...bytes.slice(0, 4));
    assert.equal(header, "%PDF");
  });

  it("emits one page per chapter", () => {
    const one = buildStoryMapHandoutPdf([chapter()], opts({ orientation: "portrait" }));
    const three = buildStoryMapHandoutPdf(
      [chapter(), chapter(), chapter()],
      opts({ paperSize: "letter", title: "T", footer: "F" }),
    );
    // The "/Count N" entry in the page tree reports the page count.
    const count = (bytes: Uint8Array): number => {
      const text = Buffer.from(bytes).toString("latin1");
      const match = text.match(/\/Count (\d+)/);
      return match ? Number(match[1]) : -1;
    };
    assert.equal(count(one), 1);
    assert.equal(count(three), 3);
  });

  it("throws when given no chapters", () => {
    assert.throws(
      () => buildStoryMapHandoutPdf([], opts({ orientation: "portrait" })),
      /no chapters/,
    );
  });

  it("renders without a title or footer", () => {
    const bytes = buildStoryMapHandoutPdf(
      [chapter({ description: "" })],
      opts({ orientation: "portrait" }),
    );
    assert.ok(bytes.length > 0);
  });

  it("embeds a chapter photo alongside the map when present", () => {
    const withPhoto = buildStoryMapHandoutPdf(
      [chapter({ photo: { data: PNG_2X2, width: 400, height: 300 } })],
      opts({ title: "T", footer: "F" }),
    );
    const withoutPhoto = buildStoryMapHandoutPdf([chapter()], opts({ title: "T", footer: "F" }));
    // The photo page embeds a second image, so its byte stream is larger.
    assert.ok(withPhoto.length > withoutPhoto.length);
  });

  it("renders a subtitle and byline without throwing", () => {
    const bytes = buildStoryMapHandoutPdf(
      [chapter()],
      opts({
        title: "Title",
        subtitle: "A subtitle",
        byline: "By GeoLibre",
        footer: "Footer",
      }),
    );
    assert.ok(bytes.length > 0);
  });

  it("embeds a clickable link annotation for a chapter marker", () => {
    const url = "https://www.google.com/maps/place/40.700000,-74.000000/@40.700000,-74.000000,12z";
    const bytes = buildStoryMapHandoutPdf(
      [chapter({ marker: { url, color: "#3fb1ce" } })],
      opts({ title: "T", footer: "F" }),
    );
    const text = Buffer.from(bytes).toString("latin1");
    // The pin carries a /URI link annotation pointing at the chapter coordinate.
    assert.ok(text.includes("/S /URI"));
    assert.ok(text.includes(url));
  });

  it("omits the link annotation when a chapter has no marker", () => {
    const bytes = buildStoryMapHandoutPdf([chapter()], opts({ title: "T", footer: "F" }));
    const text = Buffer.from(bytes).toString("latin1");
    assert.ok(!text.includes("/S /URI"));
  });

  it("draws a marker beside a chapter photo without throwing", () => {
    const bytes = buildStoryMapHandoutPdf(
      [
        chapter({
          photo: { data: PNG_2X2, width: 400, height: 300 },
          marker: { url: "https://example.com/place", color: "not-a-color" },
        }),
      ],
      opts(),
    );
    const text = Buffer.from(bytes).toString("latin1");
    assert.ok(text.includes("https://example.com/place"));
  });

  it("skips a marker whose map image is too small to hold the pin", () => {
    // An extremely wide image fits into a band only a few millimetres tall, so
    // the pin would overprint the chapter title; it is dropped instead.
    const bytes = buildStoryMapHandoutPdf(
      [
        chapter({
          map: { data: PNG_2X2, width: 8000, height: 40 },
          marker: { url: "https://example.com/place", color: "#3fb1ce" },
        }),
      ],
      opts(),
    );
    const text = Buffer.from(bytes).toString("latin1");
    assert.ok(!text.includes("/S /URI"));
  });

  it("skips a marker whose map image cannot hold the pin's outline", () => {
    // 8000x480 fits to a band about 16.4mm tall on A4 landscape: over twice the
    // bare pin height (16mm) but under twice the outlined height (16.8mm), so
    // half the image is not enough to keep the outline inside the map. Drawing
    // it would bleed white ink above the image, into the chapter title. This
    // fixture fails if the guard ever goes back to measuring the bare pin.
    const bytes = buildStoryMapHandoutPdf(
      [
        chapter({
          map: { data: PNG_2X2, width: 8000, height: 480 },
          marker: { url: "https://example.com/place", color: "#3fb1ce" },
        }),
      ],
      opts(),
    );
    const text = Buffer.from(bytes).toString("latin1");
    assert.ok(!text.includes("/S /URI"));
  });

  it("renders a full-bleed slide page", () => {
    // A full-bleed slide (start/closing screen) has no title or description and
    // still produces a valid one-page document.
    const bytes = buildStoryMapHandoutPdf(
      [{ title: "", map: { data: PNG_2X2, width: 1200, height: 900 }, fullBleed: true }],
      opts(),
    );
    assert.ok(bytes.length > 0);
    const text = Buffer.from(bytes).toString("latin1");
    const match = text.match(/\/Count (\d+)/);
    assert.equal(match ? Number(match[1]) : -1, 1);
  });
});
