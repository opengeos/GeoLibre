import {
  act,
  fireEvent,
  mockFetch,
  render,
  screen,
  useAppStore,
  useDesktopSettingsStore,
  waitFor,
} from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import { createEmptyProject, serializeProject, type GeoLibreLayer } from "@geolibre/core";

// Loaded after the harness so the dialog's CSS imports and Vite globals resolve.
const { ShareProjectDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/ShareProjectDialog");

const originalConfirm = window.confirm;
afterEach(() => {
  window.confirm = originalConfirm;
});

const PROJECT = {
  id: "p1",
  username: "tester",
  slug: "my-map",
  projectUrl: "https://share.geolibre.app/tester/my-map",
  viewerUrl: "https://web.geolibre.app/?url=https://share.geolibre.app/tester/my-map.geolibre.json",
  rawJsonUrl: "https://share.geolibre.app/tester/my-map.geolibre.json",
};

interface Call {
  url: string;
  method: string;
  body: unknown;
  auth: string | null;
}

/** Serve the share API from canned responses and record every request. */
function shareServer(
  options: {
    upload?: { status: number; body: unknown };
    shares?: unknown[] | "unsupported";
  } = {},
) {
  const calls: Call[] = [];
  const json = (status: number, body: unknown) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  mockFetch(async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    calls.push({
      url,
      method,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      auth: headers.get("Authorization"),
    });
    const path = new URL(url).pathname;
    if (path === "/api/projects" && method === "POST") {
      const upload = options.upload ?? { status: 201, body: { project: PROJECT } };
      return json(upload.status, upload.body);
    }
    if (path === "/api/shares" && method === "GET") {
      if (options.shares === "unsupported") return json(404, {});
      return json(200, { shares: options.shares ?? [] });
    }
    if (path.startsWith("/api/shares/") && method === "DELETE") return json(204, null);
    return json(404, {});
  });
  return calls;
}

function setToken(token: string) {
  const state = useDesktopSettingsStore.getState();
  useDesktopSettingsStore.setState({
    desktopSettings: { ...state.desktopSettings, shareToken: token },
  });
}

function renderShare(
  overrides: Partial<{
    currentTitle: string;
    onOpenChange: (open: boolean) => void;
    getProject: (
      title: string,
    ) => Promise<{ content: string; filename: string; redactedCount?: number }>;
  }> = {},
) {
  const requested: string[] = [];
  const view = render(
    createElement(ShareProjectDialog, {
      open: true,
      onOpenChange: overrides.onOpenChange ?? (() => {}),
      currentTitle: overrides.currentTitle ?? "Trail map",
      getProject:
        overrides.getProject ??
        (async (title: string) => {
          requested.push(title);
          return {
            content: serializeProject(createEmptyProject(title)),
            filename: "trail-map.geolibre.json",
            redactedCount: 2,
          };
        }),
    }),
  );
  return { ...view, requested };
}

describe("ShareProjectDialog", () => {
  it("walks an author without a token through setup and warns about local-only layers", () => {
    shareServer();
    const local = {
      id: "disk",
      name: "Survey points",
      type: "geojson",
      visible: true,
      opacity: 1,
      sourcePath: "/home/me/survey.gpkg",
      metadata: {},
      source: { type: "geojson", data: "/home/me/survey.gpkg" },
    } as unknown as GeoLibreLayer;
    act(() => useAppStore.setState({ layers: [local] }));
    let open = true;
    renderShare({ onOpenChange: (next) => (open = next) });
    assert.ok(screen.getByRole("dialog", { name: "Share project" }));
    assert.ok(screen.getByRole("button", { name: "Get API token" }));
    const warning = screen.queryByTestId("share-local-warning");
    assert.match(warning?.textContent ?? "", /1 layer will be missing from the shared map/);
    assert.match(warning?.textContent ?? "", /Survey points/);
    assert.equal(screen.queryByRole("button", { name: "Share" }), null);
    fireEvent.click(screen.getByRole("button", { name: "Configure local token" }));
    assert.equal(open, false);
  });

  it("uploads under the edited title with the chosen settings and shows the link", async () => {
    setToken("glb_test");
    const calls = shareServer();
    const { requested } = renderShare();
    const title = screen.getByLabelText("Project title") as HTMLInputElement;
    assert.equal(title.value, "Trail map");
    fireEvent.change(title, { target: { value: "  Ridge trail  " } });
    fireEvent.change(screen.getByLabelText("Access role"), { target: { value: "view" } });
    fireEvent.change(screen.getByLabelText("Link expiry"), { target: { value: "7d" } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    await waitFor(() => assert.match(document.body.textContent ?? "", /Your project is live at:/), {
      onTimeout: () => new Error(document.body.textContent ?? ""),
    });
    assert.deepEqual(requested, ["Ridge trail"]);
    const upload = calls.find((call) => call.method === "POST")!;
    assert.equal(upload.auth, "Bearer glb_test");
    assert.equal((upload.body as { filename: string }).filename, "trail-map.geolibre.json");
    assert.equal((upload.body as { role?: string }).role, "view");
    assert.equal(
      (screen.getByDisplayValue(PROJECT.projectUrl) as HTMLInputElement).value,
      PROJECT.projectUrl,
    );
    assert.match(document.body.textContent ?? "", /2 credential field\(s\) were not included/);
  });

  it("asks for a title before sharing the default project name", () => {
    setToken("glb_test");
    shareServer();
    renderShare({ currentTitle: "Untitled Project" });
    assert.equal((screen.getByLabelText("Project title") as HTMLInputElement).value, "");
    assert.equal(screen.getByRole("button", { name: "Share" }).hasAttribute("disabled"), true);
  });

  it("reports a failed upload and lets the author retry", async () => {
    setToken("glb_test");
    shareServer({ upload: { status: 500, body: { error: "boom" } } });
    renderShare();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() =>
      assert.equal(screen.getByRole("button", { name: "Share" }).hasAttribute("disabled"), false),
    );
    assert.equal(screen.queryByText("Your project is live at:"), null);
    const text = document.body.textContent ?? "";
    assert.ok(text.includes("boom") || /HTTP 500|Could not share/.test(text), text.slice(-400));
  });

  it("lists active shares and revokes one only after confirmation", async () => {
    setToken("glb_test");
    const calls = shareServer({
      shares: [
        { id: "s1", title: "Ridge trail", slug: "ridge", visibility: "unlisted", role: "edit" },
        { id: "s2", title: "Lake loop", slug: "lake", visibility: "public", role: "view" },
      ],
    });
    renderShare();
    fireEvent.click(screen.getByRole("button", { name: "Active shares" }));
    const text = () => document.body.textContent ?? "";
    await waitFor(() => assert.ok(text().includes("Lake loop")));
    assert.ok(text().includes("Ridge trail"));
    assert.equal(screen.queryAllByRole("button", { name: "Revoke" }).length, 2);

    window.confirm = () => false;
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]!);
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);

    window.confirm = () => true;
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]!);
    await waitFor(() => assert.ok(!text().includes("Ridge trail")));
    const revoke = calls.find((call) => call.method === "DELETE")!;
    assert.match(revoke.url, /\/api\/shares\/s1$/);
    assert.ok(text().includes("Lake loop"));
  });

  it("explains a share host that cannot list share links", async () => {
    setToken("glb_test");
    shareServer({ shares: "unsupported" });
    renderShare();
    fireEvent.click(screen.getByRole("button", { name: "Active shares" }));
    await waitFor(() => assert.match(document.body.textContent ?? "", /does not list share links/));
  });
});
