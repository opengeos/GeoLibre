import { openCatalogNode, type StacCatalogNode } from "./stac-api";
import { el } from "../panel-dom";

const ROW_CLASS = "geolibre-stac-tree-row";
const STYLE_ID = "geolibre-stac-tree-style";

/**
 * Selection is one attribute and one rule: `aria-selected` says what is chosen and the stylesheet
 * decides what that looks like. Painting a row by hand would hold the same fact in two places,
 * free to disagree, and a highlight left on a row nobody picked misreports the search's scope.
 */
const CSS = `
.${ROW_CLASS} {
  display: flex;
  gap: 4px;
  align-items: center;
  width: 100%;
  padding-block: 2px;
  padding-inline-end: 4px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.${ROW_CLASS}[aria-selected="true"] {
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
}
`;

const style = {
  tree:
    "min-height:170px;max-height:340px;overflow:auto;resize:vertical;padding:4px;border-radius:5px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));",
  glyph: "width:10px;flex:0 0 auto;color:hsl(var(--muted-foreground));",
  empty: "font-size:10px;color:hsl(var(--muted-foreground));",
} as const;

const GLYPH = { open: "▾", leaf: "•", busy: "…" } as const;

// Ties each row to the group it opens, which the markup cannot: the group is its sibling. Counted
// per document rather than per tree, so two trees cannot mint the same id.
let groupCount = 0;

/** A closed folder points the way the text runs, so it mirrors with the rest of the UI. */
function closedGlyph(): string {
  return typeof document !== "undefined" && document.documentElement.dir === "rtl" ? "◂" : "▸";
}

/** Adds the tree's one stylesheet, once per document. */
function ensureStyle(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const sheet = el("style");
  sheet.id = STYLE_ID;
  sheet.textContent = CSS;
  document.head.append(sheet);
}

export interface CatalogTree {
  element: HTMLElement;
  /** Replaces the tree with a new catalog's top-level children. */
  reset: (nodes: StacCatalogNode[]) => void;
  /** Documents of the collections the user has picked, as search entry points. */
  selection: () => string[];
}

/** One row of the tree, and the branch hanging off it. */
interface Row {
  element: HTMLButtonElement;
  box: HTMLDivElement;
  parent?: Row;
  children: Row[];
  open: boolean;
}

export interface CatalogTreeOptions {
  labels: { empty: string; openFailed: string };
  onError: (message: string) => void;
  /** A collection was double-clicked: search it, and go to it if its extent is known. */
  onActivate?: (href: string, bbox?: [number, number, number, number]) => void;
  signal?: AbortSignal;
  /** Reads one node. Injected so the tree can be driven without a network. */
  read?: typeof openCatalogNode;
}

/** A catalog rendered as a tree, reading each node's children only when it is opened. */
export function buildCatalogTree(options: CatalogTreeOptions): CatalogTree {
  const { labels, onError, onActivate, signal, read = openCatalogNode } = options;
  /** A read stops when its connection is replaced, or when the panel itself goes away. */
  const reads = (connection: AbortSignal): AbortSignal =>
    signal ? AbortSignal.any([connection, signal]) : connection;
  ensureStyle();
  const element = el("div");
  element.style.cssText = style.tree;
  element.setAttribute("role", "tree");
  element.setAttribute("aria-multiselectable", "true");
  // Keyed by row, not by document: the same collection is often linked from two branches, and
  // keying by document would let a click on one row cancel the other.
  const selected = new Map<HTMLElement, string>();
  /**
   * One connection's worth of reading. Replacing the catalog aborts it, so reads in flight stop
   * rather than finishing into a tree that has moved on, and every path that resumes after an
   * `await` has the same one thing to check.
   */
  let session = new AbortController();
  // Asking for a row is asking for the newest one: a request that waited on a slow read must not
  // land after the user has asked for something else.
  let asking = new AbortController();

  // The tree built every row, so it keeps its own shape rather than reading it back out of the
  // DOM — and the arrows can then move by parent and child instead of by selector.
  const roots: Row[] = [];

  const everyRow = (within: Row[] = roots): Row[] =>
    within.flatMap((row) => [row, ...everyRow(row.children)]);

  /** The rows a reader can reach: a closed folder hides everything under it. */
  const reachable = (within: Row[] = roots): Row[] =>
    within.flatMap((row) => (row.open ? [row, ...reachable(row.children)] : [row]));

  /** One tab stop for the whole tree: a catalog of hundreds of rows is not hundreds of stops. */
  const focusRow = (row: Row | undefined): void => {
    if (!row) return;
    for (const other of everyRow()) other.element.tabIndex = other === row ? 0 : -1;
    row.element.focus();
  };

  const mark = (row: HTMLElement, on: boolean): void => {
    row.setAttribute("aria-selected", String(on));
  };

  /** Drops the choices inside a subtree being hidden: nothing on screen would show them. */
  const forget = (box: HTMLElement): void => {
    for (const [row] of selected) {
      if (!box.contains(row)) continue;
      selected.delete(row);
      mark(row, false);
    }
  };

  const select = (href: string, row: HTMLElement, additive: boolean): void => {
    // Ctrl/Cmd-click toggles, and so does clicking the one row already chosen — without it a
    // touch user could never undo a choice. Clicking one of several chosen rows narrows to it.
    const toggles = additive || (selected.has(row) && selected.size === 1);
    if (toggles && selected.delete(row)) return mark(row, false);
    if (!additive) {
      for (const [other] of selected) mark(other, false);
      selected.clear();
    }
    selected.set(row, href);
    mark(row, true);
  };

  const addNode = (node: StacCatalogNode, parent: Row | undefined, depth: number): void => {
    // The connection this row belongs to; it is aborted when the catalog is replaced.
    const mine = session.signal;
    const row = el("button");
    row.type = "button";
    row.className = ROW_CLASS;
    row.style.paddingInlineStart = `${4 + depth * 12}px`;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-selected", "false");
    row.setAttribute("aria-level", String(depth + 1));
    row.tabIndex = roots.length ? -1 : 0;
    const glyph = el("span", node.kind === "collection" ? GLYPH.leaf : closedGlyph());
    glyph.style.cssText = style.glyph;
    row.append(glyph, el("span", node.title));
    const childrenBox = el("div");
    childrenBox.hidden = true;
    childrenBox.setAttribute("role", "group");
    groupCount += 1;
    childrenBox.id = `${ROW_CLASS}-group-${groupCount}`;
    row.setAttribute("aria-owns", childrenBox.id);
    (parent?.box ?? element).append(row, childrenBox);

    const self: Row = { element: row, box: childrenBox, parent, children: [], open: false };
    (parent?.children ?? roots).push(self);

    let kind = node.kind;
    let loaded = false;
    /** The read in flight, if any: it stands in for a busy flag and can be waited on. */
    let reading: Promise<void> | undefined;
    let bbox: [number, number, number, number] | undefined;
    if (kind !== "collection") row.setAttribute("aria-expanded", "false");

    const expand = (wanted: boolean): void => {
      if (!wanted) forget(childrenBox);
      self.open = wanted;
      childrenBox.hidden = !wanted;
      row.setAttribute("aria-expanded", String(wanted));
      glyph.textContent = wanted ? GLYPH.open : closedGlyph();
    };

    /**
     * Reads what is inside the node: what it turned out to be, what it holds, and where it is.
     * `choose` marks the read a click asked for, since opening a folder with the arrows must not
     * change what is chosen. A collection is read too, once, after it has been chosen: its link
     * says it is a leaf, and a link cannot see the sub-collections a Maxar event turns out to
     * hold.
     */
    const reveal = (choose: boolean, additive: boolean): Promise<void> => {
      if (loaded) return Promise.resolve();
      // A second gesture joins the read already running rather than starting another.
      reading ??= readNode(choose, additive);
      return reading;
    };

    const readNode = async (choose: boolean, additive: boolean): Promise<void> => {
      const scope = reads(mine);
      glyph.textContent = GLYPH.busy;
      try {
        const opened = await read(node.href, fetch, scope);
        // The catalog this row belongs to may have been replaced while the read was in flight,
        // or the panel itself closed.
        if (scope.aborted) return;
        kind = opened.kind;
        loaded = true;
        bbox = opened.bbox;
        for (const child of opened.children) addNode(child, self, depth + 1);
        // A row a search can be pointed at: one carrying its own items, with or without
        // sub-catalogs, and one with nothing to open at all — including the empty node, which
        // can then be chosen like any other and simply searches to nothing.
        if (opened.items || !opened.children.length) kind = "collection";
        if (kind === "collection" && choose) select(node.href, row, additive);
        if (opened.children.length) return expand(true);
        glyph.textContent = GLYPH.leaf;
        row.removeAttribute("aria-expanded");
        if (opened.items) return;
        const empty = el("div", labels.empty);
        empty.style.cssText = `${style.empty}padding-inline-start:${16 + depth * 12}px;`;
        childrenBox.append(empty);
        childrenBox.hidden = false;
      } catch (error) {
        if (scope.aborted) return;
        glyph.textContent = closedGlyph();
        // The translated sentence carries the meaning; the raw text says which failure it was.
        const detail = error instanceof Error ? error.message : String(error);
        onError(`${labels.openFailed}: ${detail}`);
      } finally {
        reading = undefined;
      }
    };

    /** What a click or Space means: choose a collection, or open a folder. */
    const activate = (additive: boolean): void => {
      // A collection is chosen at once, without waiting on the network, and read once so that
      // whatever it holds can be reached: Maxar's events are collections of collections, and a
      // link alone cannot say so. The search reads the same document moments later.
      if (kind === "collection") {
        // Once such a row is chosen, a click browses what it holds rather than un-choosing it —
        // collapsing a folder must not quietly widen the next search back to the whole catalog.
        // Ctrl/Cmd-click still lets go of it, as it does anywhere else.
        if (!additive && self.children.length && selected.has(row)) return expand(!self.open);
        select(node.href, row, additive);
        if (!loaded) void reveal(false, additive);
        return;
      }
      if (loaded) return expand(!self.open);
      void reveal(true, additive);
    };

    row.addEventListener("click", (event) => {
      focusRow(self);
      activate(event.ctrlKey || event.metaKey);
    });

    /**
     * "Show me this one": pick the collection if it is not picked, then ask for its items. The
     * clicks of a double-click land before it, so a row still being read is waited for — without
     * that, double-clicking a folder that turns out to be a collection searches nothing.
     */
    const show = async (): Promise<void> => {
      asking.abort();
      asking = new AbortController();
      const request = asking.signal;
      await reading;
      // Neither a newer request nor a catalog the user has left: either would search one thing
      // and send the map to another.
      if (request.aborted || mine.aborted || kind !== "collection") return;
      if (!selected.has(row)) select(node.href, row, false);
      onActivate?.(node.href, bbox);
    };

    // The second click of a double-click would otherwise toggle the choice back off, so the
    // selection is restored before the search is asked for.
    row.addEventListener("dblclick", () => void show());

    // The arrows walk the tree and work its folders. Enter and Space are left to the button the
    // row is written on, which already chooses; asking for the items takes the modifier.
    row.addEventListener("keydown", (event) => {
      const step = (by: number): void => {
        const list = reachable();
        focusRow(list[list.indexOf(self) + by]);
      };
      const steps: Record<string, () => void> = {
        ArrowDown: () => step(1),
        ArrowUp: () => step(-1),
        // Opening a folder is navigation, not a choice: it must not disturb what is chosen, and
        // it believes a `collection.json` link exactly as a click does rather than reading a row
        // per arrow press.
        ArrowRight: () => {
          if (self.open) return focusRow(self.children[0]);
          if (loaded) return void (self.children.length && expand(true));
          void reveal(false, false);
        },
        ArrowLeft: () => {
          if (self.open) return expand(false);
          focusRow(self.parent);
        },
        // Ctrl+Enter means "show me this one" whatever the row turns out to be: a container is
        // read first, and searched if that read reveals a collection.
        "Ctrl+Enter": () => {
          if (kind !== "collection" && !loaded) activate(false);
          void show();
        },
        Home: () => focusRow(reachable()[0]),
        End: () => focusRow(reachable().at(-1)),
      };
      // A modifier only changes what a key means when there is something for it to mean; holding
      // Ctrl while arrowing should still walk the tree rather than swallow the press.
      const held = event.ctrlKey || event.metaKey;
      const take = (held ? steps[`Ctrl+${event.key}`] : undefined) ?? steps[event.key];
      if (!take) return;
      event.preventDefault();
      take();
    });
  };

  return {
    element,
    reset(nodes) {
      session.abort();
      session = new AbortController();
      element.innerHTML = "";
      selected.clear();
      roots.length = 0;
      for (const node of nodes) addNode(node, undefined, 0);
    },
    selection: () => [...new Set(selected.values())],
  };
}
