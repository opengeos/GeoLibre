import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  cancelConversionJob,
  cancelWhiteboxJob,
  setSidecarFetch,
} from "../packages/processing/src";

afterEach(() => {
  setSidecarFetch(null);
});

function recordRequests(response: () => Response): { url: string; method: string }[] {
  const requests: { url: string; method: string }[] = [];
  setSidecarFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method ?? "GET" });
    return response();
  }) as typeof fetch);
  return requests;
}

const cancelledJob = {
  id: "job/1",
  status: "cancelled",
  tool_id: "tool",
  created_at: "",
  updated_at: "",
  messages: [],
  outputs: {},
  error: "Cancelled.",
};

describe("sidecar job cancellation", () => {
  it("POSTs a conversion cancel to the encoded job URL and returns the job", async () => {
    const requests = recordRequests(() => new Response(JSON.stringify(cancelledJob)));
    const job = await cancelConversionJob("job/1", "http://sidecar");
    assert.deepEqual(requests, [
      { url: "http://sidecar/conversion/jobs/job%2F1/cancel", method: "POST" },
    ]);
    assert.equal(job.status, "cancelled");
  });

  it("POSTs a Whitebox cancel to the encoded job URL and returns the job", async () => {
    const requests = recordRequests(() => new Response(JSON.stringify(cancelledJob)));
    const job = await cancelWhiteboxJob("job/1", "http://sidecar");
    assert.deepEqual(requests, [
      { url: "http://sidecar/whitebox/jobs/job%2F1/cancel", method: "POST" },
    ]);
    assert.equal(job.status, "cancelled");
  });

  it("surfaces the sidecar's detail when the job is unknown", async () => {
    recordRequests(
      () => new Response(JSON.stringify({ detail: "Job not found" }), { status: 404 }),
    );
    await assert.rejects(cancelConversionJob("gone", "http://sidecar"), /Job not found/);
    await assert.rejects(cancelWhiteboxJob("gone", "http://sidecar"), /Job not found/);
  });
});
