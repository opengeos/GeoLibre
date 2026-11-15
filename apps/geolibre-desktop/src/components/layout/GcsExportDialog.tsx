import { useEffect, useRef, useState } from "react";
import { Button, Input, Label } from "@geolibre/ui";
import { useTranslation } from "react-i18next";
import { Cloud, Loader2, X } from "lucide-react";

/**
 * App-wide dialog for harvesting and exporting to Google Cloud Storage.
 * Opened by the floating button or Ctrl+Shift+G shortcut.
 */
export function GcsExportDialog() {
  const { t } = useTranslation();
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
    setError(null);
    setResult(null);
    setOpen(false);
  };

  // Keyboard shortcut: Ctrl+Shift+G
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const [backendUrl, setBackendUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [dataUrl, setDataUrl] = useState("");
  const [licenceName, setLicenceName] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRun = async () => {
    if (!dataUrl.trim()) {
      setError(t("gcsExport.errors.dataUrlRequired"));
      return;
    }
    let backend: URL;
    try {
      backend = new URL(backendUrl.trim());
      if (
        backend.protocol !== "https:" ||
        backend.username ||
        backend.password ||
        backend.search ||
        backend.hash
      ) {
        throw new Error();
      }
    } catch {
      setError(t("gcsExport.errors.httpsBackendRequired"));
      return;
    }
    const endpoint = backend.href.replace(/\/$/, "");
    operationRef.current?.abort();
    const operation = new AbortController();
    operationRef.current = operation;
    const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(30 * 60 * 1000)]);
    setStatus("running");
    setError(null);
    setResult(null);
    try {
      const resp = await fetch(`${endpoint}/harvest-large`, {
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
        const detail = typeof err?.detail === "string" ? err.detail : undefined;
        const message = typeof err?.error === "string" ? err.error : undefined;
        throw new Error(detail || message || t("gcsExport.errors.http", { status: resp.status }));
      }
      const execution = (await resp.json())?.execution;
      signal.throwIfAborted();
      if (typeof execution !== "string" || !execution)
        throw new Error(t("gcsExport.errors.missingExecution"));
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
        const pollResp = await fetch(`${endpoint}/harvest-large/${encodeURIComponent(execution)}`, {
          headers: { "X-API-Key": apiKey },
          signal,
        });
        if (!pollResp.ok) throw new Error(t("gcsExport.errors.http", { status: pollResp.status }));
        const poll = await pollResp.json();
        signal.throwIfAborted();
        if (
          !poll ||
          !["pending", "queued", "running", "succeeded", "failed", "completed"].includes(
            poll.status,
          )
        ) {
          throw new Error(t("gcsExport.errors.invalidStatus"));
        }
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
            setError(
              typeof poll.log_tail === "string"
                ? poll.log_tail
                : t("gcsExport.errors.harvestFailed"),
            );
          }
        }
      }
    } catch (e) {
      if (operation.signal.aborted) return;
      setStatus("error");
      setError(
        signal.aborted ? t("gcsExport.errors.timeout") : e instanceof Error ? e.message : String(e),
      );
    }
  };

  return (
    <>
      <button
        hidden={open}
        onClick={() => setOpen(true)}
        className="fixed bottom-4 end-4 z-40 bg-primary hover:bg-primary/90 text-primary-foreground rounded-full p-3 shadow-lg"
        title={t("gcsExport.triggerTitle")}
        aria-label={t("gcsExport.triggerTitle")}
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
        <div className="bg-popover text-popover-foreground rounded-lg p-6 w-full max-w-lg space-y-4 border border-border">
          <div className="flex items-center justify-between">
            <h2
              id="gcs-export-title"
              className="text-lg font-bold text-foreground flex items-center gap-2"
            >
              <Cloud className="w-5 h-5" /> {t("gcsExport.title")}
            </h2>
            <button
              aria-label={t("common.close")}
              onClick={closeDialog}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <Label htmlFor="gcs-backend">{t("gcsExport.backendUrl")}</Label>
              <Input
                id="gcs-backend"
                value={backendUrl}
                onChange={(e) => setBackendUrl(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="gcs-api-key">{t("gcsExport.apiKey")}</Label>
              <Input
                id="gcs-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="gcs-data-url">{t("gcsExport.dataUrl")}</Label>
              <Input
                id="gcs-data-url"
                value={dataUrl}
                onChange={(e) => setDataUrl(e.target.value)}
                placeholder="https://www.data.qld.gov.au/dataset/..."
              />
            </div>
            <div>
              <Label htmlFor="gcs-licence">{t("gcsExport.licence")}</Label>
              <Input
                id="gcs-licence"
                value={licenceName}
                onChange={(e) => setLicenceName(e.target.value)}
              />
            </div>
          </div>

          {error && <div className="text-destructive text-sm">{error}</div>}
          {result && (
            <pre className="bg-muted p-3 rounded text-xs overflow-auto max-h-48 text-foreground">
              {result}
            </pre>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={closeDialog}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleRun} disabled={status === "running"}>
              {status === "running" ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin me-2" /> {t("gcsExport.running")}
                </>
              ) : (
                <>
                  <Cloud className="w-4 h-4 me-2" /> {t("gcsExport.run")}
                </>
              )}
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}
