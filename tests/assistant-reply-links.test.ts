import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openReplyLink } from "../apps/geolibre-desktop/src/lib/assistant/reply-links";

/** A click whose target sits inside a link with this `href`, or outside any link. */
function click(href: string | null) {
  const link =
    href === null ? null : { getAttribute: (name: string) => (name === "href" ? href : null) };
  let prevented = false;
  const event = {
    target: {
      closest: (selector: string) => (selector === "a[href]" ? link : null),
    } as unknown as EventTarget,
    preventDefault: () => {
      prevented = true;
    },
  };
  const opened: string[] = [];
  const handled = openReplyLink(event, (url) => opened.push(url));
  return { handled, prevented, opened };
}

describe("assistant reply links", () => {
  it("opens an http(s) link outside the app instead of navigating", () => {
    assert.deepEqual(click("https://www.ingv.it"), {
      handled: true,
      prevented: true,
      opened: ["https://www.ingv.it"],
    });
    assert.deepEqual(click("HTTP://example.org/a?b=1").opened, ["HTTP://example.org/a?b=1"]);
  });

  it("cancels in-page and other links without opening anything", () => {
    for (const href of [
      "#section",
      "/relative",
      "mailto:someone@example.org",
      "javascript:alert(1)",
    ]) {
      assert.deepEqual(click(href), { handled: true, prevented: true, opened: [] }, href);
    }
  });

  it("leaves clicks outside links alone", () => {
    assert.deepEqual(click(null), { handled: false, prevented: false, opened: [] });
    let prevented = false;
    const handled = openReplyLink(
      { target: null, preventDefault: () => (prevented = true) },
      () => {},
    );
    assert.equal(handled, false);
    assert.equal(prevented, false);
  });
});
