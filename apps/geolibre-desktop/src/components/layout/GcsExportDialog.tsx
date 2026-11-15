import { useEffect, useState } from "react";
import { Button, Input, Label } from "@geolibre/ui";
import { Cloud, Loader2, X } from "lucide-react";

/**
 * App-wide dialog for harvesting and exporting to Google Cloud Storage.
 * Triggered via the "Export to GCS" menu item.
 */
export function GcsExportDialog() {
  const [open, setOpen] = useState(false);

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

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 bg-sky-600 hover:bg-sky-500 text-white rounded-full p-3 shadow-lg"
        title="Harvest & Export to GCS (Ctrl+Shift+G)"
      >
        <Cloud className="w-5 h-5" />
      </button>
    );
  }

  const handleRun = async () => {
    if (!dataUrl.trim()) {
      setError("Data URL is required");
      return;
    }
    setStatus("running");
    setError(null);
    setResult(null);
    try {
      const resp = await fetch(`${backendUrl.replace(/\/$/, "")}/harvest-large`, {
        method: "POST",
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
      let done = false;
      while (!done) {
        await new Promise((r) => setTimeout(r, 5000));
        const pollResp = await fetch(
          `${backendUrl.replace(/\/$/, "")}/harvest-large/${execution}`,
          { headers: { "X-API-Key": apiKey } },
        );
        const poll = await pollResp.json();
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
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-slate-900 rounded-lg p-6 w-full max-w-lg space-y-4 border border-slate-700">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-sky-300 flex items-center gap-2">
            <Cloud className="w-5 h-5" /> Harvest & Export to GCS
          </h2>
          <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <Label>Backend URL (Cloud Run)</Label>
            <Input value={backendUrl} onChange={(e) => setBackendUrl(e.target.value)} />
          </div>
          <div>
            <Label>API Key</Label>
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </div>
          <div>
            <Label>Data URL (portal or direct file)</Label>
            <Input
              value={dataUrl}
              onChange={(e) => setDataUrl(e.target.value)}
              placeholder="https://www.data.qld.gov.au/dataset/..."
            />
          </div>
          <div>
            <Label>Licence (direct downloads)</Label>
            <Input value={licenceName} onChange={(e) => setLicenceName(e.target.value)} />
          </div>
        </div>

        {error && <div className="text-red-400 text-sm">{error}</div>}
        {result && (
          <pre className="bg-slate-800 p-3 rounded text-xs overflow-auto max-h-48 text-green-300">
            {result}
          </pre>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleRun} disabled={status === "running"}>
            {status === "running" ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" /> Running...
              </>
            ) : (
              <>
                <Cloud className="w-4 h-4 mr-2" /> Harvest & Export
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
