import { useEffect, useRef, useState } from "react";
import { Button, Input, Label } from "@geolibre/ui";
import { Cloud, Loader2, X } from "lucide-react";

/**
 * App-wide dialog for harvesting and exporting to Google Cloud Storage.
 * Triggered via the "Export to GCS" menu item.
 */
export function GcsExportDialog() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const operationRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      operationRef.current?.abort();
      operationRef.current = null;
      dialog?.close();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [open]);

  const closeDialog = () => {
    operationRef.current?.abort();
    setStatus("idle");
    setOpen(false);
  };

  // Keyboard shortcut: Ctrl+Shift+G
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "G") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const [backendUrl, setBackendUrl] = useState(
    "https://oic-harvester-482213551331.australia-southeast1.run.app",
  );
  const [apiKey, setApiKey] = useState("");
  const [dataUrl, setDataUrl] = useState("");
  const [licenceName, setLicenceName] = useState("CC-BY-4.0");
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRun = async () => {
    if (!dataUrl.trim()) {
      setError("Data URL is required");
      return;
    }
    operationRef.current?.abort();
    const operation = new AbortController();
    operationRef.current = operation;
    const { signal } = operation;
    setStatus("running");
    setError(null);
    setResult(null);
    try {
      const resp = await fetch(`${backendUrl.replace(/\/$/, "")}/harvest-large`, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify({
          url: dataUrl.trim(),
          dry_run: false,
          skip_wherobots: false,
          refresh_geolibre: true,
          licence_name: licenceName.trim() || null,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail || err.error || `HTTP ${resp.status}`);
      }
      const { execution } = await resp.json();
      signal.throwIfAborted();
      if (typeof execution !== "string" || !execution)
        throw new Error("Missing harvest execution ID");
      let done = false;
      while (!done) {
        await new Promise<void>((resolve, reject) => {
          signal.throwIfAborted();
          const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, 5000);
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const pollResp = await fetch(
          `${backendUrl.replace(/\/$/, "")}/harvest-large/${encodeURIComponent(execution)}`,
          { headers: { "X-API-Key": apiKey }, signal },
        );
        if (!pollResp.ok) throw new Error(`HTTP ${pollResp.status}`);
        const poll = await pollResp.json();
        signal.throwIfAborted();
        if (
          poll.status === "succeeded" ||
          poll.status === "failed" ||
          poll.status === "completed"
        ) {
          done = true;
          if (poll.status === "succeeded" || poll.status === "completed") {
            setStatus("done");
            setResult(JSON.stringify(poll.result || poll, null, 2));
          } else {
            setStatus("error");
            setError(poll.log_tail || "Harvest failed");
          }
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <button
        hidden={open}
        onClick={() => setOpen(true)}
        className="fixed bottom-4 end-4 z-40 bg-sky-600 hover:bg-sky-500 text-white rounded-full p-3 shadow-lg"
        title="Harvest & Export to GCS (Ctrl+Shift+G)"
      >
        <Cloud className="w-5 h-5" />
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby="gcs-export-title"
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
        className="m-auto bg-transparent p-0 backdrop:bg-black/60"
      >
        <div className="bg-slate-900 rounded-lg p-6 w-full max-w-lg space-y-4 border border-slate-700">
          <div className="flex items-center justify-between">
            <h2
              id="gcs-export-title"
              className="text-lg font-bold text-sky-300 flex items-center gap-2"
            >
              <Cloud className="w-5 h-5" /> Harvest & Export to GCS
            </h2>
            <button
              aria-label="Close"
              onClick={closeDialog}
              className="text-slate-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <Label htmlFor="gcs-backend">Backend URL (Cloud Run)</Label>
              <Input
                id="gcs-backend"
                value={backendUrl}
                onChange={(e) => setBackendUrl(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="gcs-api-key">API Key</Label>
              <Input
                id="gcs-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="gcs-data-url">Data URL (portal or direct file)</Label>
              <Input
                id="gcs-data-url"
                value={dataUrl}
                onChange={(e) => setDataUrl(e.target.value)}
                placeholder="https://www.data.qld.gov.au/dataset/..."
              />
            </div>
            <div>
              <Label htmlFor="gcs-licence">Licence (direct downloads)</Label>
              <Input
                id="gcs-licence"
                value={licenceName}
                onChange={(e) => setLicenceName(e.target.value)}
              />
            </div>
          </div>

          {error && <div className="text-red-400 text-sm">{error}</div>}
          {result && (
            <pre className="bg-slate-800 p-3 rounded text-xs overflow-auto max-h-48 text-green-300">
              {result}
            </pre>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={closeDialog}>
              Cancel
            </Button>
            <Button onClick={handleRun} disabled={status === "running"}>
              {status === "running" ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin me-2" /> Running...
                </>
              ) : (
                <>
                  <Cloud className="w-4 h-4 me-2" /> Harvest & Export
                </>
              )}
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}
