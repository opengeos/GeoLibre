import { fireEvent, render, screen } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";

const { AddCommentDialog } =
  await import("../apps/geolibre-desktop/src/components/comments/AddCommentDialog");

const pendingComment = {
  anchor: { type: "point" as const, lngLat: [-83.92, 35.96] as [number, number] },
  point: { x: 10, y: 10 },
};

afterEach(() => {
  localStorage.clear();
});

describe("AddCommentDialog author name (#3477)", () => {
  it("shows the session name a live-session comment is posted under", () => {
    localStorage.setItem("geolibre_author_name", "Reviewer A");
    const submitted: Array<[string, string | undefined]> = [];
    render(
      createElement(AddCommentDialog, {
        pendingComment,
        onSubmit: (body: string, name?: string) => submitted.push([body, name]),
        onCancel: () => {},
        sessionName: "Host",
      }),
    );
    assert.ok(screen.getByText("Host"));
    assert.equal(screen.queryByText("Reviewer A"), null);

    fireEvent.change(screen.getByLabelText("Comment / feedback"), {
      target: { value: "Check this hydrant" },
    });
    fireEvent.submit(screen.getByLabelText("Comment / feedback").closest("form")!);
    assert.deepEqual(submitted, [["Check this hydrant", "Host"]]);
    // The session name never replaces the name saved for comments outside one.
    assert.equal(localStorage.getItem("geolibre_author_name"), "Reviewer A");
  });

  it("shows the saved name outside a session", () => {
    localStorage.setItem("geolibre_author_name", "Reviewer A");
    render(
      createElement(AddCommentDialog, {
        pendingComment,
        onSubmit: () => {},
        onCancel: () => {},
      }),
    );
    assert.ok(screen.getByText("Reviewer A"));
  });
});
