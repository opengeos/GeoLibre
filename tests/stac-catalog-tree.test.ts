import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { buildCatalogTree } from "../packages/plugins/src/plugins/stac-catalog-tree";
import type { StacCatalogNode, StacOpenedNode } from "../packages/plugins/src/plugins/stac-api";

const LABELS = { empty: "«empty»", openFailed: "«open failed»" };

/**
 * The tree writes styles and reads them back, so a hand-written double would only ever prove that
 * the double round-trips. linkedom parses and re-serializes declarations the way a browser does.
 */
async function withDom(body: () => Promise<void> | void): Promise<void> {
  const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
  const globals = globalThis as Record<string, unknown>;
  const saved = { document: globals.document, Event: globals.Event };
  globals.document = document;
  globals.Event = window.Event;
  try {
    await body();
  } finally {
    globals.document = saved.document;
    globals.Event = saved.Event;
  }
}

function node(title: string, kind: StacCatalogNode["kind"] = "container"): StacCatalogNode {
  return { href: `https://example.com/${title}.json`, title, kind };
}

/** Every row in document order, however deeply nested. */
function rowsOf(tree: { element: HTMLElement }): HTMLElement[] {
  return [...tree.element.querySelectorAll("[role=treeitem]")] as HTMLElement[];
}

/**
 * Dispatches the way a browser does — fire and forget, so a second click can land while the first
 * read is still outstanding. linkedom has no MouseEvent, and the tree reads only the modifiers.
 */
function click(row: HTMLElement, additive = false): void {
  const event = new (globalThis as { Event: typeof Event }).Event("click", { bubbles: true });
  Object.assign(event, { ctrlKey: additive, metaKey: false });
  row.dispatchEvent(event);
}

/** A key press the tree's own handler will see. */
function press(row: HTMLElement, key: string, ctrlKey = false): void {
  const event = new (globalThis as { Event: typeof Event }).Event("keydown", { bubbles: true });
  Object.assign(event, { key, ctrlKey, metaKey: false });
  row.dispatchEvent(event);
}

/** Lets the handler's awaits run to completion. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * What the row says it is. The stylesheet turns that into a highlight, which only a real browser
 * can resolve — `e2e/stac-catalog-tree.spec.ts` is what checks the colour.
 */
function isChosen(row: HTMLElement): boolean {
  return row.getAttribute("aria-selected") === "true";
}

test("a row that leaves the selection stops being painted as selected", async () => {
  await withDom(async () => {
    const tree = buildCatalogTree({
      labels: LABELS,
      onError: (message) => assert.fail(`unexpected error: ${message}`),
      read: async () => ({ kind: "collection", children: [] }),
    });
    tree.reset([node("Hazards", "collection"), node("Geology", "collection")]);
    const [hazards, geology] = rowsOf(tree);

    click(hazards);
    await settle();
    assert.equal(isChosen(hazards), true);

    // The bug this pins: the previous row kept its highlight, so several rows looked chosen
    // while the search used one of them.
    click(geology);
    await settle();
    assert.deepEqual(tree.selection(), ["https://example.com/Geology.json"]);
    assert.equal(isChosen(hazards), false, "the replaced row must lose its highlight");
    assert.equal(hazards.getAttribute("aria-selected"), "false");
    assert.equal(isChosen(geology), true);
  });
});

test("clicking a chosen row again clears it, which is the only way to do so by touch", async () => {
  await withDom(async () => {
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {} });
    tree.reset([node("Hazards", "collection")]);
    const [row] = rowsOf(tree);

    click(row);
    await settle();
    assert.deepEqual(tree.selection(), ["https://example.com/Hazards.json"]);

    click(row);
    await settle();
    assert.deepEqual(tree.selection(), []);
    assert.equal(isChosen(row), false);
  });
});

test("Ctrl-click adds a second collection and leaves the first chosen", async () => {
  await withDom(async () => {
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {} });
    tree.reset([node("Hazards", "collection"), node("Geology", "collection")]);
    const [hazards, geology] = rowsOf(tree);

    click(hazards);
    click(geology, true);
    await settle();
    assert.deepEqual(tree.selection().sort(), [
      "https://example.com/Geology.json",
      "https://example.com/Hazards.json",
    ]);
    assert.equal(isChosen(hazards), true);
    assert.equal(isChosen(geology), true);
  });
});

test("the same collection reached down two branches is chosen once and cleared once", async () => {
  await withDom(async () => {
    // A shared collection is normal in STAC: two themes both link it. Keying the selection by
    // document rather than by row made the second click cancel the first.
    const shared: StacCatalogNode = {
      href: "https://example.com/shared/collection.json",
      title: "Shared",
      kind: "collection",
    };
    const read = async (href: string): Promise<StacOpenedNode> => ({
      kind: "container",
      children: [shared],
    });
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {}, read });
    tree.reset([node("Themes"), node("Topics")]);
    const [themes, topics] = rowsOf(tree);

    click(themes);
    await settle();
    click(topics);
    await settle();

    const shares = rowsOf(tree).filter((row) => row.textContent?.includes("Shared"));
    assert.equal(shares.length, 2);

    click(shares[0], true);
    click(shares[1], true);
    await settle();
    assert.deepEqual(tree.selection(), ["https://example.com/shared/collection.json"]);
    assert.equal(isChosen(shares[0]), true);
    assert.equal(isChosen(shares[1]), true);
  });
});

test("clicking one of several chosen rows narrows to it instead of dropping it", async () => {
  await withDom(async () => {
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {} });
    tree.reset([node("Hazards", "collection"), node("Geology", "collection")]);
    const [hazards, geology] = rowsOf(tree);

    click(hazards);
    click(geology, true);
    await settle();
    assert.equal(tree.selection().length, 2);

    // The row is already chosen, but so is another: a plain click means "just this one".
    click(hazards);
    await settle();
    assert.deepEqual(tree.selection(), ["https://example.com/Hazards.json"]);
    assert.equal(isChosen(geology), false);
  });
});

test("collapsing a folder gives up the choices hidden inside it", async () => {
  await withDom(async () => {
    const read = async (): Promise<StacOpenedNode> => ({
      kind: "container",
      children: [node("Hazards", "collection")],
    });
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {}, read });
    tree.reset([node("Themes")]);
    const [themes] = rowsOf(tree);

    click(themes);
    await settle();
    const [, hazards] = rowsOf(tree);
    click(hazards);
    await settle();
    assert.equal(tree.selection().length, 1);

    // Nothing on screen could show this row as chosen once it is hidden, and a search the user
    // cannot see the scope of is worse than one that lost it.
    click(themes);
    await settle();
    assert.equal((themes.nextElementSibling as HTMLElement).hidden, true);
    assert.deepEqual(tree.selection(), []);
    assert.equal(isChosen(hazards), false);
  });
});

test("a catalog opened after a reset cannot take the previous catalog's selection", async () => {
  await withDom(async () => {
    let release: (value: StacOpenedNode) => void = () => {};
    const read = async (): Promise<StacOpenedNode> =>
      new Promise<StacOpenedNode>((resolve) => {
        release = resolve;
      });
    const errors: string[] = [];
    const tree = buildCatalogTree({
      labels: LABELS,
      onError: (message) => errors.push(message),
      read,
    });

    tree.reset([node("Old")]);
    click(rowsOf(tree)[0]);
    // The user connects to a different catalog while that read is still in flight.
    tree.reset([node("New", "collection")]);
    release({ kind: "collection", children: [] });
    await settle();

    assert.deepEqual(tree.selection(), [], "a stale read must not select into the new catalog");
    assert.deepEqual(errors, []);
    assert.deepEqual(
      rowsOf(tree).map((row) => row.textContent),
      ["•New"],
    );
  });
});

test("a container is read once, and collapsing it hides its children without re-reading", async () => {
  await withDom(async () => {
    let opens = 0;
    const read = async (): Promise<StacOpenedNode> => {
      opens += 1;
      return { kind: "container", children: [node("Hazards", "collection")] };
    };
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {}, read });
    tree.reset([node("Themes")]);
    const [themes] = rowsOf(tree);

    click(themes);
    await settle();
    const box = themes.nextElementSibling as HTMLElement;
    assert.equal(opens, 1);
    assert.equal(box.hidden, false);
    assert.equal(themes.getAttribute("aria-expanded"), "true");

    click(themes);
    await settle();
    assert.equal(box.hidden, true, "a second click collapses");
    assert.equal(themes.getAttribute("aria-expanded"), "false");

    click(themes);
    await settle();
    assert.equal(box.hidden, false);
    assert.equal(opens, 1, "the children are not read again");
  });
});

test("a second click while a node is being read does not read it twice", async () => {
  await withDom(async () => {
    let opens = 0;
    let release: (value: StacOpenedNode) => void = () => {};
    const read = async (): Promise<StacOpenedNode> => {
      opens += 1;
      return new Promise<StacOpenedNode>((resolve) => {
        release = resolve;
      });
    };
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {}, read });
    tree.reset([node("Themes")]);
    const [themes] = rowsOf(tree);

    // Real dispatch is fire-and-forget, so the second click lands mid-read.
    click(themes);
    click(themes);
    release({ kind: "container", children: [] });
    await settle();
    assert.equal(opens, 1);
  });
});

test("a node that cannot be read says so in the translated wording and stays openable", async () => {
  await withDom(async () => {
    let attempts = 0;
    const errors: string[] = [];
    const read = async (): Promise<StacOpenedNode> => {
      attempts += 1;
      if (attempts === 1) throw new Error("503 Service Unavailable");
      return { kind: "container", children: [node("Hazards", "collection")] };
    };
    const tree = buildCatalogTree({ labels: LABELS, onError: (m) => errors.push(m), read });
    tree.reset([node("Themes")]);
    const [themes] = rowsOf(tree);

    click(themes);
    await settle();
    assert.deepEqual(errors, [`${LABELS.openFailed}: 503 Service Unavailable`]);
    assert.equal(themes.getAttribute("aria-expanded"), "false");

    click(themes);
    await settle();
    assert.equal(attempts, 2, "a failed read leaves the node openable");
    assert.equal(rowsOf(tree).length, 2);
  });
});

test("a read that fails with something other than an Error still says what happened", async () => {
  await withDom(async () => {
    const errors: string[] = [];
    // Not everything a fetch layer throws is an Error: a rejected string or a plain object would
    // otherwise reach the panel as an empty reason.
    const read = async (): Promise<StacOpenedNode> => {
      throw "gateway said no";
    };
    const tree = buildCatalogTree({ labels: LABELS, onError: (m) => errors.push(m), read });
    tree.reset([node("Themes")]);

    click(rowsOf(tree)[0]);
    await settle();
    assert.deepEqual(errors, [`${LABELS.openFailed}: gateway said no`]);
  });
});

test("an aborted read is not reported as a failure", async () => {
  await withDom(async () => {
    const controller = new AbortController();
    const errors: string[] = [];
    const read = async (): Promise<StacOpenedNode> => {
      controller.abort();
      throw new DOMException("signal is aborted without reason", "AbortError");
    };
    const tree = buildCatalogTree({
      labels: LABELS,
      onError: (message) => errors.push(message),
      signal: controller.signal,
      read,
    });
    tree.reset([node("Themes")]);

    click(rowsOf(tree)[0]);
    await settle();
    assert.deepEqual(errors, []);
  });
});

test("a catalog that carries its own items is a leaf to search, not an empty folder", async () => {
  await withDom(async () => {
    // STAC lets a catalog link items with no collection in between, and the spec's own examples
    // do it. Such a node has nothing to open, but it does have data to search.
    const read = async (): Promise<StacOpenedNode> => ({
      kind: "container",
      children: [],
      items: 4,
    });
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {}, read });
    tree.reset([node("Scenes")]);
    const [scenes] = rowsOf(tree);

    click(scenes);
    await settle();
    const box = scenes.nextElementSibling as HTMLElement;
    assert.notEqual(box.textContent, LABELS.empty, "it is not empty, so it must not say so");
    assert.equal(scenes.textContent, "•Scenes");
    assert.deepEqual(
      tree.selection(),
      ["https://example.com/Scenes.json"],
      "and the search can be scoped to it",
    );
  });
});

test("a catalog holding both sub-catalogs and its own items opens and is searchable", async () => {
  await withDom(async () => {
    // Neither half cancels the other: its children are worth browsing, and its own items are
    // worth searching, so scoping a search here must not quietly leave them out.
    const read = async (): Promise<StacOpenedNode> => ({
      kind: "container",
      children: [node("Quads", "collection")],
      items: 3,
    });
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {}, read });
    tree.reset([node("Mapping")]);
    const [mapping] = rowsOf(tree);

    click(mapping);
    await settle();
    assert.equal((mapping.nextElementSibling as HTMLElement).hidden, false, "its children show");
    assert.deepEqual(
      tree.selection(),
      ["https://example.com/Mapping.json"],
      "and it can be searched itself",
    );
    assert.deepEqual(
      rowsOf(tree).map((row) => row.textContent),
      ["▾Mapping", "•Quads"],
    );
  });
});

test("an empty node says so, and can still be chosen", async () => {
  await withDom(async () => {
    const read = async (): Promise<StacOpenedNode> => ({ kind: "container", children: [] });
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {}, read });
    tree.reset([node("Themes")]);
    const [themes] = rowsOf(tree);

    click(themes);
    await settle();
    const box = themes.nextElementSibling as HTMLElement;
    assert.equal(box.textContent, LABELS.empty);
    assert.equal(box.hidden, false);
    assert.equal(box.getAttribute("role"), "group");

    // Nothing to open is not the same as nothing to do: the click that read it also chose it,
    // so a search can be pointed here.
    assert.deepEqual(tree.selection(), ["https://example.com/Themes.json"]);
    assert.equal(themes.getAttribute("aria-selected"), "true");
  });
});

test("a container that turns out to be a collection is selected by the same click", async () => {
  await withDom(async () => {
    const read = async (): Promise<StacOpenedNode> => ({ kind: "collection", children: [] });
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {}, read });
    tree.reset([node("Maps")]);
    const [maps] = rowsOf(tree);

    click(maps);
    await settle();
    assert.deepEqual(tree.selection(), ["https://example.com/Maps.json"]);
    assert.equal(isChosen(maps), true);
    assert.equal(maps.hasAttribute("aria-expanded"), false, "a leaf is not expandable");
  });
});

test("Ctrl-click drops one collection from a multiple selection", async () => {
  await withDom(async () => {
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {} });
    tree.reset([node("Hazards", "collection"), node("Geology", "collection")]);
    const [hazards, geology] = rowsOf(tree);

    click(hazards);
    click(geology, true);
    await settle();
    click(geology, true);
    await settle();
    assert.deepEqual(tree.selection(), ["https://example.com/Hazards.json"]);
    assert.equal(isChosen(geology), false);
  });
});

test("double-clicking a collection asks for its items and keeps it chosen", async () => {
  await withDom(async () => {
    const activated: Array<[string, unknown]> = [];
    const read = async (): Promise<StacOpenedNode> => ({
      kind: "collection",
      children: [],
      bbox: [-114, 37, -109, 42],
    });
    const tree = buildCatalogTree({
      labels: LABELS,
      onError: () => {},
      onActivate: (href, bbox) => activated.push([href, bbox]),
      read,
    });
    tree.reset([node("Maps")]);
    const [maps] = rowsOf(tree);

    // The read that turns a container into a collection also learns its extent.
    click(maps);
    await settle();
    // The second click of a double-click would toggle the choice off on its own.
    click(maps);
    maps.dispatchEvent(
      new (globalThis as { Event: typeof Event }).Event("dblclick", { bubbles: true }),
    );
    await settle();
    assert.deepEqual(activated, [["https://example.com/Maps.json", [-114, 37, -109, 42]]]);
    assert.deepEqual(tree.selection(), ["https://example.com/Maps.json"]);
    assert.equal(isChosen(maps), true);
  });
});

test("a folder says when it is reading, and points the way the text runs", async () => {
  await withDom(async () => {
    let release: (value: StacOpenedNode) => void = () => {};
    const read = async (): Promise<StacOpenedNode> =>
      new Promise<StacOpenedNode>((resolve) => {
        release = resolve;
      });
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {}, read });
    tree.reset([node("Themes")]);
    const [themes] = rowsOf(tree);
    const glyph = (): string => (themes.firstElementChild as HTMLElement).textContent ?? "";
    assert.equal(glyph(), "▸");

    click(themes);
    await settle();
    assert.equal(glyph(), "…", "a read in flight says so");
    release({ kind: "container", children: [node("Hazards", "collection")] });
    await settle();
    assert.equal(glyph(), "▾");

    click(themes);
    await settle();
    assert.equal(glyph(), "▸");

    // Right-to-left locales mirror the whole UI, so a closed folder must point the other way.
    document.documentElement.dir = "rtl";
    const mirrored = buildCatalogTree({ labels: LABELS, onError: () => {} });
    mirrored.reset([node("Themes")]);
    assert.equal((rowsOf(mirrored)[0].firstElementChild as HTMLElement).textContent, "◂");
    document.documentElement.dir = "";
  });
});

test("the arrows move the tree's single tab stop, and work its folders", async () => {
  await withDom(async () => {
    const read = async (): Promise<StacOpenedNode> => ({
      kind: "container",
      children: [node("Hazards", "collection"), node("Water", "collection")],
    });
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {}, read });
    tree.reset([node("Themes"), node("Topics")]);
    const [themes, topics] = rowsOf(tree);
    // linkedom reports every `tabIndex` as -1 and has no `activeElement`, so the attribute is what
    // can be judged here; `e2e/stac-catalog-tree.spec.ts` checks that focus really follows.
    const stops = (): Array<string | null> =>
      rowsOf(tree).map((row) => row.getAttribute("tabindex"));

    // A catalog can hold hundreds of rows; tabbing past each one is not navigation.
    assert.deepEqual(stops(), ["0", "-1"]);

    press(themes, "ArrowDown");
    assert.deepEqual(stops(), ["-1", "0"]);
    press(topics, "ArrowUp");
    assert.deepEqual(stops(), ["0", "-1"]);

    // Right opens a closed folder, then steps into what it revealed; left closes it again.
    press(themes, "ArrowRight");
    await settle();
    assert.equal(themes.getAttribute("aria-expanded"), "true");
    press(themes, "ArrowRight");
    assert.deepEqual(stops(), ["-1", "0", "-1", "-1"], "the first child takes the tab stop");

    press(themes, "ArrowLeft");
    assert.equal(themes.getAttribute("aria-expanded"), "false");
    press(themes, "End");
    assert.deepEqual(
      rowsOf(tree)
        .filter((row) => row.getAttribute("tabindex") === "0")
        .map((row) => row.textContent),
      ["▸Topics"],
      "End lands on the last row that is not inside a closed folder",
    );
  });
});

test("Ctrl+Enter asks for a collection's items, the way a double-click does", async () => {
  await withDom(async () => {
    const activated: string[] = [];
    const tree = buildCatalogTree({
      labels: LABELS,
      onError: () => {},
      onActivate: (href) => activated.push(href),
    });
    tree.reset([node("Hazards", "collection"), node("Themes")]);
    const [hazards, themes] = rowsOf(tree);

    // Enter and Space are the button's own, and choose the row; the browser turns them into the
    // click this tree already handles, so the tree must leave them alone.
    press(hazards, "Enter");
    await settle();
    assert.deepEqual(activated, []);

    // Nothing chosen yet: Ctrl+Enter chooses and asks in one press, so a keyboard user is not
    // left with double-click as the only way to search a collection.
    press(hazards, "Enter", true);
    await settle();
    assert.deepEqual(activated, ["https://example.com/Hazards.json"]);
    assert.deepEqual(tree.selection(), ["https://example.com/Hazards.json"]);

    press(hazards, "Enter", true);
    await settle();
    assert.equal(activated.length, 2, "asking twice is asking again, not undoing");
    assert.deepEqual(tree.selection(), ["https://example.com/Hazards.json"]);

    // A folder has no items of its own, so it opens instead.
    press(themes, "Enter", true);
    await settle();
    assert.equal(activated.length, 2);
  });
});

test("holding a modifier does not stop the arrows walking the tree", async () => {
  await withDom(async () => {
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {} });
    tree.reset([node("Hazards", "collection"), node("Geology", "collection")]);
    const [hazards] = rowsOf(tree);
    const stops = (): Array<string | null> =>
      rowsOf(tree).map((row) => row.getAttribute("tabindex"));

    // Ctrl+Enter is the one combination that means something else; every other key keeps its
    // meaning, rather than being swallowed by a lookup that only knows about Enter.
    press(hazards, "ArrowDown", true);
    assert.deepEqual(stops(), ["-1", "0"]);
    press(rowsOf(tree)[1], "Home", true);
    assert.deepEqual(stops(), ["0", "-1"]);
  });
});

test("a collection that holds collections can be closed and opened again", async () => {
  await withDom(async () => {
    const read = async (): Promise<StacOpenedNode> => ({
      kind: "collection",
      children: [node("Landsat 9", "collection")],
    });
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {}, read });
    tree.reset([node("Landsat")]);
    const [landsat] = rowsOf(tree);

    click(landsat);
    await settle();
    const box = landsat.nextElementSibling as HTMLElement;
    assert.equal(box.hidden, false);
    assert.deepEqual(tree.selection(), ["https://example.com/Landsat.json"]);

    // Left closes it; the row is a collection, so nothing else used to be willing to open it and
    // its children were gone for good.
    press(landsat, "ArrowLeft");
    assert.equal(box.hidden, true);

    press(landsat, "ArrowRight");
    await settle();
    assert.equal(box.hidden, false, "the arrows can reopen what they closed");

    click(landsat);
    await settle();
    assert.equal(box.hidden, true, "and so can a click");
    // Collapsing is browsing, not un-choosing: a search must not silently widen to the whole
    // catalog because the user tidied the tree.
    assert.deepEqual(tree.selection(), ["https://example.com/Landsat.json"]);

    // Ctrl-click is still how a row is let go of.
    click(landsat, true);
    await settle();
    assert.deepEqual(tree.selection(), []);
  });
});

test("opening a folder with the arrows leaves the selection alone", async () => {
  await withDom(async () => {
    // A row that turns out to be a collection holding collections: opening it used to choose it,
    // and choosing without a modifier clears everything else.
    const read = async (): Promise<StacOpenedNode> => ({
      kind: "collection",
      children: [node("Water", "collection")],
    });
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {}, read });
    tree.reset([node("Hazards", "collection"), node("Geology", "collection"), node("Topics")]);
    const [hazards, geology, topics] = rowsOf(tree);

    click(hazards);
    click(geology, true);
    await settle();
    assert.equal(tree.selection().length, 2);

    // Right opens the folder. A choice made elsewhere is not the folder's business.
    press(topics, "ArrowRight");
    await settle();
    assert.equal(topics.getAttribute("aria-expanded"), "true");
    assert.equal(tree.selection().length, 2, "navigating did not clear what was chosen");

    press(topics, "ArrowLeft");
    press(topics, "ArrowRight");
    await settle();
    assert.equal(topics.getAttribute("aria-expanded"), "true");
    assert.equal(tree.selection().length, 2);
  });
});

test("two trees in one document do not claim the same group", async () => {
  await withDom(async () => {
    // `aria-owns` points at an id; if two trees mint the same one, it points at either.
    const first = buildCatalogTree({ labels: LABELS, onError: () => {} });
    const second = buildCatalogTree({ labels: LABELS, onError: () => {} });
    first.reset([node("Themes"), node("Topics")]);
    second.reset([node("Themes"), node("Topics")]);

    const owned = [first, second].flatMap((tree) =>
      rowsOf(tree).map((row) => row.getAttribute("aria-owns")),
    );
    assert.equal(new Set(owned).size, owned.length, "every row owns a group of its own");
  });
});

test("choosing a collection is immediate, and reads it once to see what it holds", async () => {
  await withDom(async () => {
    // Maxar's events are collections of collections, and the link says only "collection.json".
    let reads = 0;
    const read = async (): Promise<StacOpenedNode> => {
      reads += 1;
      return { kind: "collection", children: [node("Acquisition", "collection")] };
    };
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {}, read });
    tree.reset([node("Cyclone", "collection")]);
    const [cyclone] = rowsOf(tree);

    click(cyclone);
    // Chosen before the read can answer: the network must not stand between a click and its row.
    assert.deepEqual(tree.selection(), ["https://example.com/Cyclone.json"]);

    await settle();
    assert.equal(reads, 1);
    assert.deepEqual(
      rowsOf(tree).map((row) => row.textContent),
      ["▾Cyclone", "•Acquisition"],
      "what it holds is reachable",
    );

    click(cyclone);
    await settle();
    assert.equal(reads, 1, "and it is not read again");
  });
});

test("double-clicking a folder that turns out to be a collection still searches it", async () => {
  await withDom(async () => {
    const activated: string[] = [];
    let release: (value: StacOpenedNode) => void = () => {};
    const read = async (): Promise<StacOpenedNode> =>
      new Promise<StacOpenedNode>((resolve) => {
        release = resolve;
      });
    const tree = buildCatalogTree({
      labels: LABELS,
      onError: () => {},
      onActivate: (href) => activated.push(href),
      read,
    });
    // The link says nothing, so the row starts as a folder and only the read can settle it.
    tree.reset([{ href: "https://example.com/maps", title: "Maps", kind: "container" }]);
    const [maps] = rowsOf(tree);

    // A real double-click is click, click, dblclick — all before a network read can answer.
    click(maps);
    click(maps);
    maps.dispatchEvent(
      new (globalThis as { Event: typeof Event }).Event("dblclick", { bubbles: true }),
    );
    release({ kind: "collection", children: [], items: 2 });
    await settle();

    assert.deepEqual(activated, ["https://example.com/maps"], "the search was not dropped");
    assert.deepEqual(tree.selection(), ["https://example.com/maps"]);
  });
});

test("a double-click answered after the catalog changes asks for nothing", async () => {
  await withDom(async () => {
    const activated: string[] = [];
    let release: (value: StacOpenedNode) => void = () => {};
    const read = async (): Promise<StacOpenedNode> =>
      new Promise<StacOpenedNode>((resolve) => {
        release = resolve;
      });
    const tree = buildCatalogTree({
      labels: LABELS,
      onError: () => {},
      onActivate: (href) => activated.push(href),
      read,
    });
    // A row the link already calls a collection: its kind survives a stale read, so nothing else
    // would stop the activation landing after the catalog changed.
    tree.reset([node("Old", "collection")]);
    const [old] = rowsOf(tree);

    click(old);
    old.dispatchEvent(
      new (globalThis as { Event: typeof Event }).Event("dblclick", { bubbles: true }),
    );
    // The user connects elsewhere before the read comes back.
    tree.reset([node("New", "collection")]);
    release({ kind: "collection", children: [], items: 3 });
    await settle();

    assert.deepEqual(activated, [], "a row from a catalog the user has left asks for nothing");
    assert.deepEqual(tree.selection(), []);
  });
});

test("reset drops the previous catalog's rows and selection", async () => {
  await withDom(async () => {
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {} });
    tree.reset([node("Hazards", "collection")]);
    click(rowsOf(tree)[0]);
    await settle();
    assert.equal(tree.selection().length, 1);

    tree.reset([node("Water", "collection")]);
    assert.deepEqual(tree.selection(), []);
    assert.deepEqual(
      rowsOf(tree).map((row) => row.textContent),
      ["•Water"],
    );
  });
});

test("the tree carries the roles and indentation a nested list needs", async () => {
  await withDom(async () => {
    const read = async (): Promise<StacOpenedNode> => ({
      kind: "container",
      children: [node("Hazards", "collection")],
    });
    const tree = buildCatalogTree({ labels: LABELS, onError: () => {}, read });
    tree.reset([node("Themes")]);
    assert.equal(tree.element.getAttribute("role"), "tree");
    assert.equal(tree.element.getAttribute("aria-multiselectable"), "true");

    const [themes] = rowsOf(tree);
    click(themes);
    await settle();
    const [, hazards] = rowsOf(tree);
    // Depth has to read as depth without a physical direction, so right-to-left locales mirror.
    assert.match(hazards.style.cssText, /padding-inline-start/);
    assert.doesNotMatch(hazards.style.cssText, /padding-left/);
    assert.equal((themes.nextElementSibling as HTMLElement).getAttribute("role"), "group");
  });
});
