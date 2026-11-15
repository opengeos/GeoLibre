import { act, cleanup, fireEvent, render, screen, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, it, mock } from "node:test";
import { createElement } from "react";

const { GcsExportDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/GcsExportDialog");

afterEach(() => {
  cleanup();
  mock.restoreAll();
});

function openDialog() {
  render(createElement(GcsExportDialog));
  fireEvent.click(screen.getByTitle("Harvest & Export to GCS (Ctrl+Shift+G)"));
  fireEvent.change(screen.getByLabelText("Data URL (portal or direct file)"), {
    target: { value: "https://example.com/data.json" },
  });
}

it("cancels an in-flight request on dismissal and allows a fresh run", async () => {
  let signal: AbortSignal | undefined;
  mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
    signal = options?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
    });
  });
  openDialog();
  fireEvent.click(screen.getByRole("button", { name: "Harvest & Export" }));
  await waitFor(() => assert.ok(signal));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  assert.equal(signal?.aborted, true);
  fireEvent.click(screen.getByTitle("Harvest & Export to GCS (Ctrl+Shift+G)"));
  assert.equal(
    screen.getByRole("button", { name: "Harvest & Export" }).hasAttribute("disabled"),
    false,
  );
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
