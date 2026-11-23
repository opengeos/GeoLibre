import { act, fireEvent, render, screen, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement, useState } from "react";
import { useSidecarJobCancellation } from "../apps/geolibre-desktop/src/hooks/useSidecarJobCancellation";

type Job = { id: string; status: string };

function Harness({ cancel }: { cancel: (id: string) => Promise<Job> }) {
  const [job, setJob] = useState<Job | null>({ id: "one", status: "running" });
  const [error, setError] = useState<string | null>(null);
  const { cancellingJob, cancelSidecarJob } = useSidecarJobCancellation(
    job,
    job?.status === "running",
    cancel,
    setJob,
    setError,
    "Cancel failed",
  );
  return createElement(
    "div",
    null,
    createElement("output", { "data-testid": "job" }, `${job?.id}:${job?.status}`),
    createElement("output", { "data-testid": "error" }, error),
    createElement(
      "button",
      { disabled: cancellingJob, onClick: () => void cancelSidecarJob() },
      "Cancel",
    ),
    createElement("button", { onClick: () => setJob({ id: "two", status: "running" }) }, "New job"),
    createElement(
      "button",
      { onClick: () => setJob({ id: "one", status: "cancelled" }) },
      "Poll finished",
    ),
  );
}

it("applies a terminal cancellation response even if job polling has stopped", async () => {
  render(createElement(Harness, { cancel: async (id) => ({ id, status: "cancelled" }) }));
  fireEvent.click(screen.getByText("Cancel"));
  await waitFor(() => assert.equal(screen.getByTestId("job").textContent, "one:cancelled"));
});

it("does not replace a newer job with a late cancellation response", async () => {
  let finish!: (job: Job) => void;
  render(
    createElement(Harness, {
      cancel: () =>
        new Promise<Job>((resolve) => {
          finish = resolve;
        }),
    }),
  );
  fireEvent.click(screen.getByText("Cancel"));
  assert.equal(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"), true);
  fireEvent.click(screen.getByText("New job"));
  await act(async () => {
    finish({ id: "one", status: "cancelled" });
  });
  assert.equal(screen.getByTestId("job").textContent, "two:running");
  assert.equal(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"), false);
});

it("surfaces cancellation failures and allows another attempt", async () => {
  render(
    createElement(Harness, {
      cancel: async () => {
        throw new Error("Sidecar unavailable");
      },
    }),
  );
  fireEvent.click(screen.getByText("Cancel"));
  await waitFor(() => assert.equal(screen.getByTestId("error").textContent, "Sidecar unavailable"));
  assert.equal(screen.getByTestId("job").textContent, "one:running");
  assert.equal(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"), false);
});

it("keeps a terminal state when a delayed cancellation response still reports running", async () => {
  let finish!: (job: Job) => void;
  render(
    createElement(Harness, {
      cancel: () =>
        new Promise<Job>((resolve) => {
          finish = resolve;
        }),
    }),
  );
  fireEvent.click(screen.getByText("Cancel"));
  fireEvent.click(screen.getByText("Poll finished"));
  assert.equal(screen.getByTestId("job").textContent, "one:cancelled");
  await act(async () => {
    finish({ id: "one", status: "running" });
  });
  assert.equal(screen.getByTestId("job").textContent, "one:cancelled");
});
