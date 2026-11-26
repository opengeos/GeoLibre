import { useAppCapability, useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
  Select,
  Textarea,
} from "@geolibre/ui";
import { useId, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { createAppAPI } from "../../hooks/usePlugins";
import { useOgcProcesses } from "../../hooks/useOgcProcesses";
import { downloadOgcProcessOutput, type OgcProcessOutput } from "../../lib/ogc-api-processes";
import {
  canImportOgcProcessOutput,
  importOgcProcessOutput,
  ogcProcessOutputFileName,
  ogcProcessOutputPreview,
} from "../../lib/ogc-process-results";
import { saveBinaryFileWithFallback } from "../../lib/file-io/file-dialogs";
import { AddDataError } from "../layout/add-data/shared";
import { OgcProcessInputs } from "./OgcProcessInputs";

/** Discover remote processes, submit typed inputs and manage numerical result snapshots. */
export function OgcProcessesDialog({
  mapControllerRef,
}: {
  mapControllerRef: RefObject<MapEngine | null>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const open = useAppStore((state) => state.ui.ogcProcessesOpen);
  const setOpen = useAppStore((state) => state.setOgcProcessesOpen);
  const client = useOgcProcesses(open);
  const processing = useAppCapability("processing:run");
  const adding = useAppCapability("layers:add-remote");
  const exporting = useAppCapability("export:data");
  const running = client.job?.status === "accepted" || client.job?.status === "running";
  const download = (output: OgcProcessOutput) => {
    if (!exporting.granted) return;
    void client.run("output", async ({ signal }) => {
      const blob = await downloadOgcProcessOutput(output, signal);
      signal.throwIfAborted();
      const name = ogcProcessOutputFileName(output.id, blob.type);
      const extension = name.split(".").pop() ?? "bin";
      await saveBinaryFileWithFallback(blob, {
        defaultName: name,
        filters: [{ name: t("processing.ogcProcesses.resultFile"), extensions: [extension] }],
        browserTypes: [
          {
            description: t("processing.ogcProcesses.resultFile"),
            accept: { "application/octet-stream": [`.${extension}`] },
          },
        ],
        mimeType: blob.type || "application/octet-stream",
      });
    });
  };
  const add = (output: OgcProcessOutput) => {
    if (!adding.granted) return;
    void client.run("output", async ({ signal }) => {
      await importOgcProcessOutput(
        output,
        client.jobUrl || client.process?.url || client.endpoint,
        createAppAPI(mapControllerRef),
        signal,
      );
    });
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[90vh] max-w-4xl grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <DialogTitle>{t("processing.ogcProcesses.title")}</DialogTitle>
          <DialogDescription>{t("processing.ogcProcesses.description")}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 pe-3">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-service`}>{t("processing.ogcProcesses.serviceUrl")}</Label>
              <div className="flex gap-2">
                <Input
                  id={`${id}-service`}
                  value={client.endpoint}
                  disabled={client.busy}
                  onChange={(event) => client.changeEndpoint(event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={client.busy || !processing.granted || !client.endpoint.trim()}
                  onClick={() => {
                    void client.retrieve();
                  }}
                >
                  {t("processing.ogcProcesses.retrieve")}
                </Button>
              </div>
            </div>
            {client.processes.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-process`}>{t("processing.ogcProcesses.process")}</Label>
                <Select
                  id={`${id}-process`}
                  value={client.selectedId}
                  disabled={client.busy}
                  onChange={(event) => {
                    void client.select(event.target.value);
                  }}
                >
                  {client.processes.map((process) => (
                    <option key={process.id} value={process.id}>
                      {process.title}
                    </option>
                  ))}
                </Select>
                {client.process && (
                  <p className="text-sm text-muted-foreground">{client.process.description}</p>
                )}
              </div>
            )}
            <div className="grid gap-5 md:grid-cols-2">
              <section className="space-y-3" aria-label={t("processing.ogcProcesses.inputs")}>
                <h3 className="font-medium">{t("processing.ogcProcesses.inputs")}</h3>
                <p className="text-xs text-muted-foreground">
                  {t("processing.ogcProcesses.sendNotice")}
                </p>
                {client.process && (
                  <>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={client.jsonMode}
                        disabled={client.busy}
                        onChange={(event) => client.toggleJson(event.target.checked)}
                      />
                      {t("processing.ogcProcesses.jsonMode")}
                    </label>
                    {client.jsonMode ? (
                      <div className="space-y-1.5">
                        <Label htmlFor={`${id}-json`}>
                          {t("processing.ogcProcesses.inputsJson")}
                        </Label>
                        <Textarea
                          id={`${id}-json`}
                          className="min-h-52 font-mono text-xs"
                          value={client.inputsJson}
                          disabled={client.busy}
                          onChange={(event) => client.setInputsJson(event.target.value)}
                        />
                      </div>
                    ) : (
                      <OgcProcessInputs
                        process={client.process}
                        values={client.values}
                        onChange={client.setValues}
                        disabled={client.busy}
                      />
                    )}
                    <div className="space-y-1.5">
                      <Label htmlFor={`${id}-mode`}>
                        {t("processing.ogcProcesses.executionMode")}
                      </Label>
                      <Select
                        id={`${id}-mode`}
                        disabled={client.busy}
                        value={client.asynchronous ? "async" : "sync"}
                        onChange={(event) => client.setAsynchronous(event.target.value === "async")}
                      >
                        <option
                          value="sync"
                          disabled={
                            client.process.jobControlOptions.length > 0 &&
                            !client.process.jobControlOptions.includes("sync-execute")
                          }
                        >
                          {t("processing.ogcProcesses.synchronous")}
                        </option>
                        <option
                          value="async"
                          disabled={!client.process.jobControlOptions.includes("async-execute")}
                        >
                          {t("processing.ogcProcesses.asynchronous")}
                        </option>
                      </Select>
                    </div>
                  </>
                )}
              </section>
              <section className="space-y-3" aria-label={t("processing.ogcProcesses.job")}>
                {client.outputs.length > 0 && (
                  <>
                    <h3 className="font-medium">{t("processing.ogcProcesses.results")}</h3>
                    {client.outputs.map((output, index) => (
                      <div
                        key={`${output.id}-${index}`}
                        className="space-y-2 rounded-md border p-3"
                      >
                        <p className="text-sm font-medium">{output.id}</p>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">
                          {output.bytes
                            ? t("processing.ogcProcesses.outputBytes", {
                                count: output.bytes.length,
                              })
                            : ogcProcessOutputPreview(output)}
                        </pre>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={client.busy || !exporting.granted}
                            onClick={() => download(output)}
                          >
                            {t("processing.ogcProcesses.download")}
                          </Button>
                          {canImportOgcProcessOutput(output) && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={client.busy || !adding.granted}
                              onClick={() => add(output)}
                            >
                              {t("processing.ogcProcesses.addToMap")}
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                    <hr />
                  </>
                )}
                <h3 className="font-medium">{t("processing.ogcProcesses.job")}</h3>
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-job`}>{t("processing.ogcProcesses.jobUrl")}</Label>
                  <Input
                    id={`${id}-job`}
                    value={client.jobUrl}
                    disabled={client.busy}
                    onChange={(event) => client.setJobUrl(event.target.value)}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("processing.ogcProcesses.jobNotice")}
                </p>
                {client.job && (
                  <div className="space-y-1" role="status">
                    <p>{t(`processing.ogcProcesses.status.${client.job.status}`)}</p>
                    {client.job.progress !== undefined && (
                      <progress
                        className="w-full accent-primary"
                        max={100}
                        value={client.job.progress}
                        aria-label={t("processing.ogcProcesses.progress")}
                      />
                    )}
                    {client.job.message && (
                      <p className="text-xs text-muted-foreground">{client.job.message}</p>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={client.busy || !processing.granted || !client.jobUrl.trim()}
                    onClick={() => {
                      void client.resume();
                    }}
                  >
                    {t("processing.ogcProcesses.resume")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      !processing.granted ||
                      !client.jobUrl.trim() ||
                      client.phase === "dismissing" ||
                      client.job?.status === "dismissed"
                    }
                    onClick={() => {
                      void client.dismiss();
                    }}
                  >
                    {t("processing.ogcProcesses.dismiss")}
                  </Button>
                </div>
              </section>
            </div>
            {client.error && <AddDataError message={client.error} />}
          </div>
        </ScrollArea>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <p className="text-xs text-muted-foreground" role="status">
            {t(`processing.ogcProcesses.phase.${client.phase}`)}
          </p>
          <div className="flex gap-2">
            {client.busy && (
              <Button type="button" variant="outline" onClick={client.stop}>
                {t("processing.ogcProcesses.stopWaiting")}
              </Button>
            )}
            <Button
              type="button"
              disabled={client.busy || !processing.granted || !client.process || running}
              onClick={() => {
                void client.execute();
              }}
            >
              {t("processing.ogcProcesses.run")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
