import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildStoryMapHandoutPdf,
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
