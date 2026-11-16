import { act, fireEvent, render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { DEFAULT_PROJECT_NAME } from "@geolibre/core";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { ProjectNameField } =
  await import("../apps/geolibre-desktop/src/components/layout/toolbar/ProjectNameField");

function field(): HTMLInputElement {
  return screen.getByRole("textbox", { name: "Project name" }) as HTMLInputElement;
}

// Issue #3474: the default name is a translated placeholder, while the store
// and saved files keep the canonical English default.
describe("ProjectNameField", () => {
  it("shows the stored default name as the placeholder", () => {
    render(createElement(ProjectNameField, { viewer: false }));
    assert.equal(useAppStore.getState().projectName, DEFAULT_PROJECT_NAME);
    assert.equal(field().value, "");
    assert.equal(field().placeholder, "Untitled project");
  });

  it("keeps a typed default name visible while editing", () => {
    render(createElement(ProjectNameField, { viewer: false }));
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: DEFAULT_PROJECT_NAME } });
    assert.equal(field().value, DEFAULT_PROJECT_NAME);
    fireEvent.blur(field());
    assert.equal(field().value, "");
    assert.equal(useAppStore.getState().projectName, DEFAULT_PROJECT_NAME);
  });

  it("stores the canonical default when the name is cleared", () => {
    useAppStore.getState().setProjectName("Rivers");
    render(createElement(ProjectNameField, { viewer: false }));
    assert.equal(field().value, "Rivers");
    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.blur(field());
    assert.equal(useAppStore.getState().projectName, DEFAULT_PROJECT_NAME);
  });

  it("does not overwrite a project loaded while the field has focus", () => {
    render(createElement(ProjectNameField, { viewer: false }));
    fireEvent.focus(field());
    act(() => useAppStore.getState().setProjectName("Loaded project"));
    assert.equal(field().value, "Loaded project");
    fireEvent.blur(field());
    assert.equal(useAppStore.getState().projectName, "Loaded project");
  });
});
