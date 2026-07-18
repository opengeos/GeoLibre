import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { restoreControlOrder } from "../packages/map/src/map-controller";

// Minimal DOM node: just enough of the Element surface restoreControlOrder
// touches (parentElement, nextElementSibling, insertBefore) plus append/remove
// to build and mutate a tree. node:test has no DOM, so we stand one up here.
class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;

  constructor(readonly id: string) {}

  get parentElement(): FakeNode | null {
    return this.parent;
  }

  get nextElementSibling(): FakeNode | null {
    if (!this.parent) return null;
    const index = this.parent.children.indexOf(this);
    return this.parent.children[index + 1] ?? null;
  }

  append(node: FakeNode): void {
    node.remove();
    node.parent = this;
    this.children.push(node);
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
    node.remove();
    node.parent = this;
    if (ref === null) {
      this.children.push(node);
      return node;
    }
    const index = this.children.indexOf(ref);
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
    return node;
  }
}

const order = (parent: FakeNode) => parent.children.map((c) => c.id);

// The helper is typed against the DOM's Element; FakeNode implements the members
// it actually uses, so cast through unknown at the call boundary.
const call = (parent: FakeNode | null, anchor: FakeNode | null, refreshed: FakeNode | null) =>
  restoreControlOrder(
    parent as unknown as Element | null,
    anchor as unknown as Element | null,
    refreshed as unknown as Element | null,
  );

describe("restoreControlOrder", () => {
  it("moves a re-appended control back to just before its old sibling", () => {
    const corner = new FakeNode("corner");
    const fullscreen = new FakeNode("fullscreen");
    const layerControl = new FakeNode("layer-control");
    const terrain = new FakeNode("terrain");
    corner.append(fullscreen);
    corner.append(layerControl);
    corner.append(terrain);

    // Capture position as refreshLayerControl does, then simulate MapLibre's
    // remove + re-append (which drops the rebuilt control at the end).
    const anchor = layerControl.nextElementSibling; // terrain
    const parent = layerControl.parentElement; // corner
    layerControl.remove();
    const refreshed = new FakeNode("layer-control");
    corner.append(refreshed); // now [fullscreen, terrain, layer-control]

    call(parent, anchor, refreshed);

    assert.deepEqual(order(corner), ["fullscreen", "layer-control", "terrain"]);
  });

  it("leaves a control that was already last at the end (null anchor)", () => {
    const corner = new FakeNode("corner");
    const terrain = new FakeNode("terrain");
    const layerControl = new FakeNode("layer-control");
    corner.append(terrain);
    corner.append(layerControl);

    const anchor = layerControl.nextElementSibling; // null (it was last)
    const parent = layerControl.parentElement;
    layerControl.remove();
    const refreshed = new FakeNode("layer-control");
    corner.append(refreshed);

    call(parent, anchor, refreshed);

    assert.deepEqual(order(corner), ["terrain", "layer-control"]);
  });

  it("no-ops when the anchor drifted to a different parent", () => {
    const corner = new FakeNode("corner");
    const refreshed = new FakeNode("layer-control");
    corner.append(refreshed);
    const otherParent = new FakeNode("other");
    const strayAnchor = new FakeNode("stray");
    otherParent.append(strayAnchor);

    call(corner, strayAnchor, refreshed);

    // Untouched: refreshed stays put, stray stays under its own parent.
    assert.deepEqual(order(corner), ["layer-control"]);
    assert.deepEqual(order(otherParent), ["stray"]);
  });

  it("no-ops safely when parent or refreshed is missing", () => {
    const corner = new FakeNode("corner");
    const terrain = new FakeNode("terrain");
    corner.append(terrain);

    assert.doesNotThrow(() => call(null, terrain, terrain));
    assert.doesNotThrow(() => call(corner, terrain, null));
    // refreshed === anchor is a no-op, not a self-insert.
    call(corner, terrain, terrain);
    assert.deepEqual(order(corner), ["terrain"]);
  });
});
