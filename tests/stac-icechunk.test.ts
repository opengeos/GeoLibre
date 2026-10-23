import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  __resetIcechunkRepositoriesForTests,
  DEFAULT_ICECHUNK_BRANCH,
  icechunkLayerUrl,
  icechunkTimeAttributesReader,
  openIcechunkStore,
  repositoryKey,
  repositoryOpenError,
  shareRepositoryOpen,
  type ZarrKeyReader,
} from "../packages/plugins/src/plugins/stac-icechunk.ts";

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

// An Icechunk repository serves nothing at its URL, so the Time Slider's usual
// metadata walk 404s six times and never binds. The reader answers the same
// question through the manifest the data already comes through.
describe("icechunkTimeAttributesReader", () => {
  it("reads the coordinate's attributes through the store", async () => {
    const asked: string[] = [];
    const read = icechunkTimeAttributesReader({
      get: async (key) => {
        asked.push(key);
        return key === "/time/.zattrs"
          ? encode({ units: "days since 1980-01-01", calendar: "standard" })
          : undefined;
      },
    });
    assert.deepEqual(await read("time"), {
      units: "days since 1980-01-01",
      calendar: "standard",
    });
    // Keys reach the manifest rooted, the way the target check asks for them.
    assert.ok(asked.every((key) => key.startsWith("/")));
  });

  it("looks inside the first pyramid level as well as the root", async () => {
    const read = icechunkTimeAttributesReader({
      get: async (key) =>
        key === "/0/time/zarr.json"
          ? encode({ attributes: { units: "hours since 2000-01-01" } })
          : undefined,
    });
    assert.deepEqual(await read("time"), { units: "hours since 2000-01-01" });
  });

  it("keeps walking when the manifest refuses a key", async () => {
    const read = icechunkTimeAttributesReader({
      get: async (key) => {
        if (key === "/time/.zattrs") throw new Error("not in this snapshot");
        return key === "/time/zarr.json"
          ? encode({ attributes: { calendar: "noleap" } })
          : undefined;
      },
    });
    assert.deepEqual(await read("time"), { calendar: "noleap" });
  });

  it("treats a key that is not a metadata document as absent", async () => {
    const read = icechunkTimeAttributesReader({
      get: async () => new TextEncoder().encode("not json"),
    });
    assert.equal(await read("time"), null);
  });

  it("reports no attributes when no document declares any", async () => {
    const read = icechunkTimeAttributesReader({ get: async () => undefined });
    assert.equal(await read("time"), null);
  });
});

// A cube's variables are added one at a time, and each add would otherwise walk refs, snapshot and
// manifests again for a repository already open.
describe("openIcechunkStore", () => {
  it("abandons an aborted open without loading the reader", async () => {
    __resetIcechunkRepositoriesForTests();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      openIcechunkStore("https://example.com/repo", "main", controller.signal),
      (error: Error) => error.name === "AbortError",
    );
  });

  it("names the branch a catalog publishes nothing for", () => {
    assert.equal(DEFAULT_ICECHUNK_BRANCH, "main");
  });
});

// A cube's variables are added one at a time, so the open is shared. The caching, the eviction and
// the abort all live here rather than behind the network, and are driven with an opener a test
// settles by hand.
describe("shareRepositoryOpen", () => {
  const reader = (name: string) => ({ get: async () => new TextEncoder().encode(name) });

  it("opens once and hands the same reader to every later caller", async () => {
    __resetIcechunkRepositoriesForTests();
    let opens = 0;
    const open = async () => {
      opens += 1;
      return reader("a");
    };
    const first = await shareRepositoryOpen(repositoryKey("repo", "main"), open);
    const second = await shareRepositoryOpen(repositoryKey("repo", "main"), open);
    assert.equal(opens, 1, "the second add reuses the walk the first paid for");
    assert.equal(first, second);
    // A different branch of the same repository is a different snapshot, so it opens on its own.
    await shareRepositoryOpen(repositoryKey("repo", "dev"), open);
    assert.equal(opens, 2);
    // Two catalogs whose url and branch merely concatenate alike stay separate entries.
    await shareRepositoryOpen(repositoryKey("https://host/a|b", "c"), open);
    await shareRepositoryOpen(repositoryKey("https://host/a", "b|c"), open);
    assert.equal(opens, 4, "a `|` in a URL does not let one repository answer for another");
  });

  it("leaves the moment a caller's signal fires, and keeps opening for the others", async () => {
    __resetIcechunkRepositoriesForTests();
    let settle: (value: ZarrKeyReader) => void = () => {};
    const open = () =>
      new Promise<ZarrKeyReader>((resolve) => {
        settle = resolve;
      });
    const controller = new AbortController();
    const leaving = shareRepositoryOpen("repo|main", open, controller.signal);
    const staying = shareRepositoryOpen("repo|main", open);
    controller.abort();
    await assert.rejects(leaving, (error: Error) => error.name === "AbortError");
    // The walk was never cancelled: the add that did not abort still gets its reader.
    settle(reader("a"));
    assert.ok(await staying);
  });

  it("refuses a caller that had already given up before it asked", async () => {
    __resetIcechunkRepositoriesForTests();
    const controller = new AbortController();
    controller.abort();
    let opened = false;
    await assert.rejects(
      shareRepositoryOpen(
        "repo|main",
        async () => {
          opened = true;
          return reader("a");
        },
        controller.signal,
      ),
      (error: Error) => error.name === "AbortError",
    );
    assert.equal(opened, false, "nothing is opened for an add that is already abandoned");
  });

  it("forgets a repository that failed, so the next add tries again", async () => {
    __resetIcechunkRepositoriesForTests();
    let opens = 0;
    const open = async () => {
      opens += 1;
      if (opens === 1) throw new Error("unsupported spec version");
      return reader("a");
    };
    await assert.rejects(shareRepositoryOpen("repo|main", open), /unsupported spec version/);
    assert.ok(await shareRepositoryOpen("repo|main", open));
    assert.equal(opens, 2);
  });
});

describe("repositoryKey", () => {
  it("keeps a url and branch that merely concatenate alike apart", () => {
    // Both halves come from the catalog, so a crafted url must not reach another's entry.
    assert.notEqual(repositoryKey("https://host/a|b", "c"), repositoryKey("https://host/a", "b|c"));
    assert.equal(repositoryKey("https://host/a", "main"), repositoryKey("https://host/a", "main"));
  });
});

// The panel shows one sentence; the reason a repository refused has to reach a developer somehow,
// and nothing in the app reads `cause`.
describe("repositoryOpenError", () => {
  it("says one thing to the panel and logs the reason behind it", () => {
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      const refused = new Error("unsupported spec version");
      const shown = repositoryOpenError(refused, "This Icechunk repository could not be opened");
      assert.equal(shown.message, "This Icechunk repository could not be opened");
      assert.equal(shown.cause, refused, "the reason rides along for anything that inspects it");
      assert.equal(logged.length, 1, "and reaches the diagnostics panel rather than nowhere");
      assert.ok((logged[0] as unknown[]).includes(refused));
    } finally {
      console.error = original;
    }
  });
});

// With a store supplied the renderer never fetches this, but it still keys the control's state, so
// two branches of one repository must not answer to the same string.
describe("icechunkLayerUrl", () => {
  it("keeps two branches of one repository apart", () => {
    const repo = "https://host/repo";
    assert.notEqual(icechunkLayerUrl(repo, "main"), icechunkLayerUrl(repo, "dev"));
  });

  it("leaves the path — what the layer is named from — untouched", () => {
    const added = icechunkLayerUrl("https://host/data/repo", "main");
    assert.ok(added.startsWith("https://host/data/repo"));
    assert.equal(new URL(added).pathname, "/data/repo");
  });

  it("survives a branch name with characters a URL would eat", () => {
    const added = icechunkLayerUrl("https://host/repo", "release/2026 #1");
    assert.equal(decodeURIComponent(new URL(added).hash), "#icechunk=release/2026 #1");
  });

  it("replaces a fragment the href already carried rather than stacking one", () => {
    const added = icechunkLayerUrl("https://host/repo#page=2", "main");
    assert.equal(added, "https://host/repo#icechunk=main");
  });

  it("names the default branch when a catalog named none", () => {
    assert.equal(
      icechunkLayerUrl("https://host/repo"),
      icechunkLayerUrl("https://host/repo", "main"),
    );
  });
});
