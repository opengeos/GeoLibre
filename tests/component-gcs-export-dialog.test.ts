import { act, cleanup, fireEvent, render, screen, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, it, mock } from "node:test";
import { createElement, useState } from "react";

const { GcsExportDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/GcsExportDialog");

afterEach(() => {
  cleanup();
  mock.restoreAll();
});

function DialogHost() {
  const [open, setOpen] = useState(true);
  return createElement(
    "div",
    null,
    createElement("button", { onClick: () => setOpen(true) }, "Open harvest"),
    createElement(GcsExportDialog, { open, onOpenChange: setOpen }),
  );
}

function openDialog() {
  render(createElement(DialogHost));
  fireEvent.change(screen.getByLabelText("Backend URL (Cloud Run)"), {
    target: { value: "https://example.com" },
  });
  fireEvent.change(screen.getByLabelText("Data URL (portal or direct file)"), {
    target: { value: "https://example.com/data.json" },
  });
}

it("lets a submission finish after dismissal without allowing a second job", async () => {
  let submitSignal: AbortSignal | undefined;
  let accept: ((response: Response) => void) | undefined;
  mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
    submitSignal = options?.signal ?? undefined;
    return new Promise<Response>((resolve) => {
      accept = resolve;
    });
  });
  openDialog();
  fireEvent.click(screen.getByRole("button", { name: "Harvest & Export" }));
  await waitFor(() => assert.ok(accept));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  assert.equal(submitSignal?.aborted, false);
  fireEvent.click(screen.getByRole("button", { name: "Open harvest" }));
  assert.equal(screen.getByRole("button", { name: "Running…" }).hasAttribute("disabled"), true);
  await act(async () => accept?.(Response.json({ execution: "run-late" })));
  await waitFor(() => assert.ok(screen.getByText(/run-late/)));
  assert.ok(screen.getByRole("button", { name: "Resume job observation" }));
  assert.equal(
    screen.getByRole("button", { name: "Harvest & Export" }).hasAttribute("disabled"),
    false,
  );
});

it("reports a submission that fails after the dialog is closed", async () => {
  let reject: ((response: Response) => void) | undefined;
  mock.method(
    globalThis,
    "fetch",
    async () =>
      new Promise<Response>((resolve) => {
        reject = resolve;
      }),
  );
  openDialog();
  fireEvent.click(screen.getByRole("button", { name: "Harvest & Export" }));
  await waitFor(() => assert.ok(reject));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => reject?.(Response.json({ detail: "Bad API key" }, { status: 401 })));
  fireEvent.click(screen.getByRole("button", { name: "Open harvest" }));
  await waitFor(() => assert.ok(screen.getByText("Bad API key")));
});

it("aborts observation when unmounted", async () => {
  let signal: AbortSignal | undefined;
  mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
    signal = options?.signal ?? undefined;
    return new Promise<Response>(() => {});
  });
  openDialog();
  fireEvent.click(screen.getByRole("button", { name: "Harvest & Export" }));
  cleanup();
  assert.equal(signal?.aborted, true);
});

it("reports HTTP polling failures and enables a new run", async () => {
  const originalTimeout = globalThis.setTimeout;
  mock.method(globalThis, "setTimeout", ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => originalTimeout(callback, delay === 5000 ? 0 : delay, ...args)) as typeof setTimeout);
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return calls === 1
      ? Response.json({ execution: "run-1" })
      : Response.json({ detail: "Unauthorized" }, { status: 401 });
  });
  openDialog();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Harvest & Export" }));
  });
  await waitFor(() => assert.ok(screen.getByText("HTTP 401")));
  assert.equal(calls, 2);
  assert.equal(
    screen.getByRole("button", { name: "Harvest & Export" }).hasAttribute("disabled"),
    false,
  );
});

it("resumes a failed observation on the original backend without submitting another job", async () => {
  const originalTimeout = globalThis.setTimeout;
  mock.method(globalThis, "setTimeout", ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => originalTimeout(callback, delay === 5000 ? 0 : delay, ...args)) as typeof setTimeout);
  const requests: Array<{ url: string; method: string; key: string | null }> = [];
  mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    requests.push({
      url,
      method: options?.method ?? "GET",
      key: new Headers(options?.headers).get("X-API-Key"),
    });
    if (requests.length === 1) return Response.json({ execution: "existing-job" });
    if (requests.length === 2) return new Response("Unavailable", { status: 503 });
    return Response.json({ status: "succeeded", result: { finished: true } });
  });
  openDialog();
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "original-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Harvest & Export" }));
  await waitFor(() => assert.ok(screen.getByText("HTTP 503")));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Open harvest" }));
  fireEvent.change(screen.getByLabelText("Backend URL (Cloud Run)"), {
    target: { value: "https://another.example.com" },
  });
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "other-backend-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Resume job observation" }));
  await waitFor(() => assert.ok(screen.getByText(/"finished": true/)));
  assert.deepEqual(requests, [
    { url: "https://example.com/harvest-large", method: "POST", key: "original-key" },
    { url: "https://example.com/harvest-large/existing-job", method: "GET", key: "original-key" },
    { url: "https://example.com/harvest-large/existing-job", method: "GET", key: "original-key" },
  ]);
  assert.equal(screen.queryByRole("button", { name: "Resume job observation" }), null);
});

it("clears the polling timer when observation stops", async () => {
  const originalTimeout = globalThis.setTimeout;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  mock.method(globalThis, "setTimeout", ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer = originalTimeout(callback, delay, ...args);
    if (delay === 5000) pollTimer = timer;
    return timer;
  }) as typeof setTimeout);
  const clear = mock.method(globalThis, "clearTimeout");
  const fetcher = mock.method(globalThis, "fetch", async () =>
    Response.json({ execution: "run-1" }),
  );
  openDialog();
  fireEvent.click(screen.getByRole("button", { name: "Harvest & Export" }));
  await waitFor(() => assert.ok(pollTimer));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  assert.ok(clear.mock.calls.some((call) => call.arguments[0] === pollTimer));
  assert.equal(fetcher.mock.callCount(), 1);
});

it("rejects an HTTP backend before sending an API key", () => {
  const fetcher = mock.method(globalThis, "fetch", async () => Response.json({}));
  openDialog();
  fireEvent.change(screen.getByLabelText("Backend URL (Cloud Run)"), {
    target: { value: "http://example.com" },
  });
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "private-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Harvest & Export" }));
  assert.ok(screen.getByText(/Enter an HTTPS backend URL/));
  assert.equal(fetcher.mock.callCount(), 0);
});

it("normalizes null, structured, and non-JSON HTTP error bodies and clears them on reopen", async () => {
  for (const response of [
    Response.json(null, { status: 422 }),
    Response.json({ detail: [{ msg: "required" }] }, { status: 422 }),
    new Response("Not JSON", { status: 422 }),
  ]) {
    mock.method(globalThis, "fetch", async () => response);
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Harvest & Export" }));
    await waitFor(() => assert.ok(screen.getByText("HTTP 422")));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Open harvest" }));
    assert.equal(screen.queryByText("HTTP 422"), null);
    cleanup();
    mock.restoreAll();
  }
});

it("stops polling when the backend returns an unknown status", async () => {
  const originalTimeout = globalThis.setTimeout;
  mock.method(globalThis, "setTimeout", ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => originalTimeout(callback, delay === 5000 ? 0 : delay, ...args)) as typeof setTimeout);
  let calls = 0;
  mock.method(globalThis, "fetch", async () =>
    Response.json(++calls === 1 ? { execution: "run" } : { status: "unknown" }),
  );
  openDialog();
  fireEvent.click(screen.getByRole("button", { name: "Harvest & Export" }));
  await waitFor(() =>
    assert.ok(screen.getByText("The backend returned an unknown harvest status.")),
  );
  assert.equal(calls, 2);
});

it("keeps the execution ID after dismissal and defaults to a dry run without Wherobots", async () => {
  const fetcher = mock.method(globalThis, "fetch", async (_url: unknown, _options?: RequestInit) =>
    Response.json({ execution: "run-1" }),
  );
  openDialog();
  fireEvent.click(screen.getByRole("button", { name: "Harvest & Export" }));
  await waitFor(() => assert.ok(screen.getByText(/run-1/)));
  const options = fetcher.mock.calls[0].arguments[1] as RequestInit;
  assert.deepEqual(JSON.parse(options.body as string), {
    url: "https://example.com/data.json",
    dry_run: true,
    skip_wherobots: true,
    refresh_geolibre: true,
    licence_name: null,
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Open harvest" }));
  assert.ok(screen.getByText(/run-1/));
  assert.ok(screen.getByText(/backend job keeps running/i));
});

it("reports a non-JSON successful submission as a missing execution ID", async () => {
  mock.method(globalThis, "fetch", async () => new Response("Not JSON"));
  openDialog();
  fireEvent.click(screen.getByRole("button", { name: "Harvest & Export" }));
  await waitFor(() => assert.ok(screen.getByText(/execution ID/i)));
});

it("shows abort API setup errors without sending a request or leaving the dialog busy", async () => {
  mock.method(AbortSignal, "any", () => {
    throw new TypeError("AbortSignal.any is unavailable");
  });
  const fetcher = mock.method(globalThis, "fetch", async () => Response.json({}));
  openDialog();
  fireEvent.click(screen.getByRole("button", { name: "Harvest & Export" }));
  await waitFor(() => assert.ok(screen.getByText("AbortSignal.any is unavailable")));
  assert.equal(fetcher.mock.callCount(), 0);
  assert.equal(
    screen.getByRole("button", { name: "Harvest & Export" }).hasAttribute("disabled"),
    false,
  );
});

it("renders the backend deployment instructions with named links", () => {
  openDialog();
  const deploy = screen.getByRole("link", { name: "deploy/harvester_service", hidden: true });
  assert.equal(
    deploy.getAttribute("href"),
    "https://github.com/GetBack2Basics/ops-intel-crafter/tree/main/deploy/harvester_service",
  );
  assert.ok(screen.getByRole("link", { name: "tools/harvest_portal_dataset.py", hidden: true }));
});
