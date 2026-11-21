import { useEffect, useRef, useState } from "react";
import { Button, Input, Label } from "@geolibre/ui";
import { Trans, useTranslation } from "react-i18next";
import { Cloud, Loader2, X } from "lucide-react";

/**
 * App-wide dialog for harvesting and exporting to Google Cloud Storage.
 * Opened from Add Data > Cloud formats.
 */
interface GcsExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface HarvestExecution {
  id: string;
  endpoint: string;
  apiKey: string;
}

/**
 * A signal that aborts when any of the given signals does. Combined by hand:
 * AbortSignal.any is missing from older desktop webviews.
 *
 * @param signals - The signals to follow.
 * @returns The combined signal.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const source of signals) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    source.addEventListener("abort", () => controller.abort(source.reason), { once: true });
  }
  return controller.signal;
}

export function GcsExportDialog({ open, onOpenChange }: GcsExportDialogProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const operationRef = useRef<AbortController | null>(null);
  // Aborts a pending submission only when the component goes away; closing
  // the dialog lets it finish so the job ID can still be recorded.
  const mountRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const mount = new AbortController();
    mountRef.current = mount;
    return () => mount.abort();
  }, []);

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
    onOpenChange(false);
  };

  const [backendUrl, setBackendUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [dataUrl, setDataUrl] = useState("");
  const [licenceName, setLicenceName] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [skipWherobots, setSkipWherobots] = useState(true);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  // True while a submission is in flight, even after the dialog is closed, so
  // a reopened dialog cannot send a second job before the first ID arrives.
  const [submitting, setSubmitting] = useState(false);
  const busy = status === "running" || submitting;
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastExecution, setLastExecution] = useState<HarvestExecution | null>(null);
  const [canResume, setCanResume] = useState(false);

  const observeHarvest = async (
    execution: string,
    endpoint: string,
    key: string,
    signal: AbortSignal,
  ) => {
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
        headers: { "X-API-Key": key },
        signal,
      });
      if (!pollResp.ok) throw new Error(t("gcsExport.errors.http", { status: pollResp.status }));
      const poll = await pollResp.json();
      signal.throwIfAborted();
      if (
        !poll ||
        !["pending", "queued", "running", "succeeded", "failed", "completed"].includes(poll.status)
      ) {
        throw new Error(t("gcsExport.errors.invalidStatus"));
      }
      if (poll.status === "succeeded" || poll.status === "failed" || poll.status === "completed") {
        done = true;
        setCanResume(false);
        if (poll.status === "succeeded" || poll.status === "completed") {
          setStatus("done");
          setResult(JSON.stringify(poll.result || poll, null, 2));
        } else {
          setStatus("error");
          setError(
            typeof poll.log_tail === "string" ? poll.log_tail : t("gcsExport.errors.harvestFailed"),
          );
        }
      }
    }
  };

  const handleRun = async (resume?: HarvestExecution) => {
    if (!resume && !dataUrl.trim()) {
      setError(t("gcsExport.errors.dataUrlRequired"));
      return;
    }
    let endpoint = resume?.endpoint;
    if (!endpoint) {
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
      endpoint = backend.href.replace(/\/$/, "");
    }
    operationRef.current?.abort();
    const operation = new AbortController();
    operationRef.current = operation;
    let signal = operation.signal;
    let submitted = false;
    setStatus("running");
    setError(null);
    setResult(null);
    const timeoutController = new AbortController();
    const timer = setTimeout(
      () => timeoutController.abort(new DOMException("timed out", "TimeoutError")),
      30 * 60 * 1000,
    );
    // Cleared in `finally` or on unmount, not on close: a hung submission must
    // still time out after the dialog is closed, or Run and Resume stay disabled.
    mountRef.current?.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    const timeout = timeoutController.signal;
    try {
      signal = anySignal([operation.signal, timeout]);
      let execution = resume?.id;
      submitted = execution !== undefined;
      if (!execution) {
        // Closing the dialog must not abort the submission: the backend may
        // already have accepted the job, and its ID is what lets a reopened
        // dialog resume observing it. Only the timeout or an unmount cancels it.
        const submitSignal = mountRef.current
          ? anySignal([mountRef.current.signal, timeout])
          : timeout;
        setSubmitting(true);
        let receivedExecution: unknown;
        try {
          const resp = await fetch(`${endpoint}/harvest-large`, {
            method: "POST",
            signal: submitSignal,
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": apiKey,
            },
            body: JSON.stringify({
              url: dataUrl.trim(),
              dry_run: dryRun,
              skip_wherobots: skipWherobots,
              refresh_geolibre: true,
              licence_name: licenceName.trim() || null,
            }),
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({ detail: resp.statusText }));
            const detail = typeof err?.detail === "string" ? err.detail : undefined;
            const message = typeof err?.error === "string" ? err.error : undefined;
            throw new Error(
              detail || message || t("gcsExport.errors.http", { status: resp.status }),
            );
          }
          receivedExecution = (await resp.json().catch(() => null))?.execution;
        } finally {
          setSubmitting(false);
        }
        if (typeof receivedExecution !== "string" || !receivedExecution)
          throw new Error(t("gcsExport.errors.missingExecution"));
        execution = receivedExecution;
        setLastExecution({ id: receivedExecution, endpoint, apiKey });
        setCanResume(true);
        submitted = true;
        signal.throwIfAborted();
      }
      await observeHarvest(execution, endpoint, resume?.apiKey ?? apiKey, signal);
    } catch (e) {
      // Closing the dialog only stops observation. A submission that failed
      // after the dialog closed is still reported, so a reopened dialog does
      // not look idle when no job was created.
      if (operation.signal.aborted && submitted) return;
      setStatus("error");
      setError(
        signal.aborted && !operation.signal.aborted
          ? t("gcsExport.errors.timeout")
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      clearTimeout(timer);
    }
  };

  return (
    <>
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

          <details className="text-sm text-muted-foreground border border-border rounded-md p-3">
            <summary className="cursor-pointer font-medium text-foreground">
              {t("gcsExport.helpTitle")}
            </summary>
            <div className="mt-2 space-y-2 text-xs leading-relaxed">
              <p>{t("gcsExport.helpWhat")}</p>
              <p>{t("gcsExport.helpBackend")}</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>
                  <Trans
                    i18nKey="gcsExport.helpStep1"
                    components={{
                      deployLink: (
                        <a
                          className="underline text-primary"
                          href="https://github.com/GetBack2Basics/ops-intel-crafter/tree/main/deploy/harvester_service"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          deploy/harvester_service
                        </a>
                      ),
                      scriptLink: (
                        <a
                          className="underline text-primary"
                          href="https://github.com/GetBack2Basics/ops-intel-crafter/blob/main/tools/harvest_portal_dataset.py"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          tools/harvest_portal_dataset.py
                        </a>
                      ),
                    }}
                  />
                </li>
                <li>{t("gcsExport.helpStep2")}</li>
                <li>{t("gcsExport.helpStep3")}</li>
                <li>{t("gcsExport.helpStep4")}</li>
              </ol>
              <p className="italic">{t("gcsExport.helpByok")}</p>
            </div>
          </details>

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

          <div className="flex items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
              />
              {t("gcsExport.dryRun")}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={skipWherobots}
                onChange={(e) => setSkipWherobots(e.target.checked)}
              />
              {t("gcsExport.skipWherobots")}
            </label>
          </div>

          {lastExecution && (
            <div className="text-xs text-muted-foreground">
              {t("gcsExport.lastExecution", { id: lastExecution.id })}
              <span className="block italic">{t("gcsExport.backendContinues")}</span>
            </div>
          )}

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
            {canResume && lastExecution && (
              <Button onClick={() => void handleRun(lastExecution)} disabled={busy}>
                {t("gcsExport.resume")}
              </Button>
            )}
            <Button onClick={() => void handleRun()} disabled={busy}>
              {busy ? (
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
