import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildStoryMapHandoutPdf,
  htmlToPlainText,
  type HandoutChapter,
} from "../apps/geolibre-desktop/src/lib/storymap-pdf";

// A valid 2x2 RGB PNG, enough for jsPDF to embed without a DOM canvas.
const PNG_2X2 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=";

function chapter(overrides: Partial<HandoutChapter> = {}): HandoutChapter {
  return {
    title: "Chapter",
    description: "Some text",
    image: PNG_2X2,
    imageWidth: 800,
    imageHeight: 600,
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
    assert.equal(
      htmlToPlainText("<p>One</p><p>Two</p>line<br>break"),
      "One\nTwo\nline\nbreak",
    );
  });

  it("collapses runs of whitespace", () => {
    assert.equal(htmlToPlainText("a   b\t c"), "a b c");
  });
});

describe("buildStoryMapHandoutPdf", () => {
  it("produces a valid PDF byte stream", () => {
    const bytes = buildStoryMapHandoutPdf([chapter()], {
      paperSize: "a4",
      orientation: "landscape",
      title: "My Story",
      footer: "Footer",
    });
    assert.ok(bytes instanceof Uint8Array);
    assert.ok(bytes.length > 0);
    // Every PDF starts with the "%PDF" magic header.
    const header = String.fromCharCode(...bytes.slice(0, 4));
    assert.equal(header, "%PDF");
  });

  it("emits one page per chapter", () => {
    const one = buildStoryMapHandoutPdf([chapter()], {
      paperSize: "a4",
      orientation: "portrait",
      title: "",
      footer: "",
    });
    const three = buildStoryMapHandoutPdf(
      [chapter(), chapter(), chapter()],
      { paperSize: "letter", orientation: "landscape", title: "T", footer: "F" },
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
      () =>
        buildStoryMapHandoutPdf([], {
          paperSize: "a4",
          orientation: "portrait",
          title: "",
          footer: "",
        }),
      /no chapters/,
    );
  });

  it("renders without a title or footer", () => {
    const bytes = buildStoryMapHandoutPdf([chapter({ description: "" })], {
      paperSize: "a4",
      orientation: "portrait",
      title: "",
      footer: "",
    });
    assert.ok(bytes.length > 0);
  });
});
