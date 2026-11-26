import {
  fireEvent,
  mockFetch,
  render,
  screen,
  useDesktopSettingsStore,
  waitFor,
} from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";

// Loaded after the harness so the dialog's CSS imports and Vite globals resolve.
const { ProjectGalleryDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/ProjectGalleryDialog");

const BASE = "https://share.geolibre.app";

function rawProject(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    username: "mapper",
    slug: id,
    title,
    description: "",
    visibility: "public",
    thumbnailUrl: null,
    views: 3,
    forkCount: 0,
    versionCount: 1,
    featured: true,
    createdAt: "2026-06-23T15:48:15.000Z",
    updatedAt: "2026-06-23T15:48:15.000Z",
    tags: ["water"],
    rawJsonUrl: `${BASE}/mapper/${id}.geolibre.json`,
    projectUrl: `${BASE}/mapper/${id}`,
    viewerUrl: `https://web.geolibre.app/?url=${BASE}/mapper/${id}.geolibre.json`,
    ...overrides,
  };
}

interface Routes {
  featured?: unknown[];
  all?: unknown[];
  mine?: unknown[];
  collections?: unknown[];
  failPublic?: number;
}

/** Serve the share API from canned listings and record every request URL. */
function shareServer(routes: Routes) {
  const urls: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  mockFetch(async (input) => {
    const url = new URL(String(input));
    urls.push(url.pathname + url.search);
    if (url.pathname === "/api/projects") {
      if (routes.failPublic) return json(routes.failPublic, {});
      const featured = url.searchParams.get("featured") === "true";
      return json(200, { projects: (featured ? routes.featured : routes.all) ?? [] });
    }
    if (url.pathname === "/api/collections/browse") {
      return json(200, { collections: routes.collections ?? [] });
    }
    if (url.pathname === "/api/users/me") return json(200, { user: { username: "me" } });
    if (url.pathname === "/api/users/me/projects")
      return json(200, { projects: routes.mine ?? [] });
    return json(404, {});
  });
  return urls;
}

function setToken(token: string) {
  const state = useDesktopSettingsStore.getState();
  useDesktopSettingsStore.setState({
    desktopSettings: { ...state.desktopSettings, shareToken: token },
  });
}

function renderGallery(
  onOpenProject: (url: string, token?: string) => Promise<boolean | void> = async () => true,
  defaultScope?: "mine",
) {
  return render(
    createElement(ProjectGalleryDialog, {
      open: true,
      onOpenChange: () => {},
      defaultScope,
      onOpenProject,
    }),
  );
}

const text = () => document.body.textContent ?? "";

describe("ProjectGalleryDialog", () => {
  it("lists featured projects and filters the loaded set in the browser", async () => {
    const urls = shareServer({
      featured: [rawProject("lakes", "Great Lakes"), rawProject("rivers", "River network")],
    });
    renderGallery();
    await waitFor(() => assert.ok(text().includes("River network")));
    assert.ok(text().includes("Great Lakes"));
    assert.ok(
      urls.some((url) => url.startsWith("/api/projects?") && url.includes("featured=true")),
    );

    fireEvent.change(screen.getByPlaceholderText(/Filter loaded projects/), {
      target: { value: "river" },
    });
    assert.ok(text().includes("River network"));
    assert.ok(!text().includes("Great Lakes"));
    fireEvent.change(screen.getByPlaceholderText(/Filter loaded projects/), {
      target: { value: "nothing like this" },
    });
    assert.ok(text().includes("No loaded projects match your filter."));
  });

  it("loads the full public listing from the All projects tab", async () => {
    const urls = shareServer({ featured: [], all: [rawProject("alps", "Alpine huts")] });
    renderGallery();
    await waitFor(() => assert.ok(text().includes("No featured projects yet.")));
    fireEvent.click(screen.getByRole("button", { name: "All projects" }));
    await waitFor(() => assert.ok(text().includes("Alpine huts")));
    assert.ok(urls.some((url) => url.startsWith("/api/projects?") && !url.includes("featured")));
  });

  it("opens a project by its raw JSON URL and reports a failed open", async () => {
    shareServer({ featured: [rawProject("lakes", "Great Lakes")] });
    const opened: string[] = [];
    let fail = true;
    renderGallery(async (url) => {
      opened.push(url);
      if (fail) throw new Error("bad file");
      return true;
    });
    await waitFor(() => assert.ok(text().includes("Great Lakes")));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      assert.ok(text().includes("bad file") || text().includes("Could not open")),
    );
    assert.deepEqual(opened, [`${BASE}/mapper/lakes.geolibre.json`]);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => assert.equal(opened.length, 2));
  });

  it("shows a load failure with a working Retry", async () => {
    const urls = shareServer({ failPublic: 500 });
    renderGallery();
    await waitFor(() => assert.ok(text().includes("HTTP 500")));
    const before = urls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => assert.ok(urls.length > before));
  });

  it("hides the personal tabs without a share token", async () => {
    shareServer({ featured: [] });
    renderGallery();
    await waitFor(() => assert.ok(text().includes("No featured projects yet.")));
    assert.equal(screen.queryByRole("button", { name: "My projects" }), null);
    assert.equal(screen.queryByRole("button", { name: "Organizations" }), null);
  });

  it("opens on My projects with a token and lists the owner's private projects", async () => {
    setToken("glb_test");
    const urls = shareServer({
      mine: [rawProject("secret", "Private survey", { visibility: "private", username: "me" })],
    });
    renderGallery(async () => true, "mine");
    await waitFor(() => assert.ok(text().includes("Private survey")));
    assert.equal(
      screen.getByRole("button", { name: "My projects" }).getAttribute("aria-pressed"),
      "true",
    );
    assert.ok(urls.includes("/api/users/me"));
    assert.ok(text().includes("Private"));
  });

  it("browses public collections", async () => {
    const urls = shareServer({
      featured: [],
      collections: [
        {
          id: "c1",
          username: "mapper",
          slug: "coasts",
          title: "Coastlines",
          description: "Shore maps",
          projectCount: 2,
        },
      ],
    });
    renderGallery();
    await waitFor(() => assert.ok(text().includes("No featured projects yet.")));
    fireEvent.click(screen.getByRole("button", { name: "Collections" }));
    await waitFor(() => assert.ok(text().includes("Coastlines")));
    assert.ok(urls.includes("/api/collections/browse"));
  });
});
