import { Button } from "@geolibre/ui";
import { Copy } from "lucide-react";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ObiaReadArea } from "@geolibre/processing";
import { snapshotObiaSession } from "../../../lib/obia/obia-persistence";
import { useObiaSession, type ObiaRunEnv } from "../../../lib/obia/obia-session";

/** A tool call as one copyable command line. */
const commandLine = (tool: string, args: readonly string[]) => [tool, ...args].join(" ");

/**
 * Provenance of the workbench's current results: the input image, the exact
 * tool calls and parameters, seeds, and the engine and app versions of each
 * run. Saved with the project, so a reopened project shows how its objects
 * and classes were made.
 */
export function ObiaProvenance(): ReactElement | null {
  const { t, i18n } = useTranslation();
  const session = useObiaSession();
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = setTimeout(() => setCopyStatus("idle"), 3000);
    return () => clearTimeout(timer);
  }, [copyStatus]);
  const { segmentation, features, classification, splits, batches } = session;
  if (!segmentation) return null;

  const when = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(
          date,
        );
  };
  const areaLine = (area: ObiaReadArea, pixelSize?: number) =>
    t(area.level ? "obia.provenance.areaOverview" : "obia.provenance.area", {
      x0: area.window[0],
      y0: area.window[1],
      x1: area.window[2],
      y1: area.window[3],
      level: area.level,
      size: pixelSize?.toLocaleString(i18n.language, { maximumSignificantDigits: 3 }) ?? "?",
    });
  const env = (value: ObiaRunEnv) =>
    t("obia.provenance.env", { engine: value.engineVersion, app: value.appVersion });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshotObiaSession(session), null, 2));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  const entry = (title: string, lines: ReactNode[]) => (
    <div className="grid gap-0.5">
      <dt className="text-xs font-medium">{title}</dt>
      {lines.map((line, i) => (
        <dd key={i} className="break-words text-xs text-muted-foreground">
          {line}
        </dd>
      ))}
    </div>
  );
  const code = (text: string) => <code className="break-all font-mono text-[11px]">{text}</code>;

  return (
    <details className="border-t pt-3" data-testid="obia-provenance">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("obia.provenance.title")}
      </summary>
      <dl className="mt-2 grid gap-2">
        {entry(t("obia.provenance.image"), [
          segmentation.source.location
            ? `${segmentation.source.name} (${segmentation.source.location})`
            : segmentation.source.name,
          t("obia.provenance.imageSize", {
            width: segmentation.width,
            height: segmentation.height,
            bands: segmentation.bandIndexes.join(", "),
          }),
          ...(segmentation.area ? [areaLine(segmentation.area, segmentation.pixelSize)] : []),
        ])}
        {entry(
          segmentation.merge
            ? t("obia.provenance.level", {
                level: session.level,
                from: segmentation.merge.fromLevel,
                scale: segmentation.merge.scale,
              })
            : t("obia.steps.segment"),
          [
            when(segmentation.finishedAt),
            code(commandLine(segmentation.tool, segmentation.args)),
            env(segmentation.env),
            segmentation.labels ? null : t("obia.provenance.labelsPending"),
          ].filter(Boolean),
        )}
        {features &&
          entry(t("obia.steps.measure"), [
            when(features.finishedAt),
            ...features.calls.map((call) => code(commandLine(call.tool, call.args))),
            env(features.env),
          ])}
        {splits.length > 0 &&
          entry(
            t("obia.provenance.splits"),
            splits.map((split) =>
              t("obia.provenance.split", {
                percent: Math.round(split.fraction * 100),
                seed: split.seed,
                count: split.moved,
              }),
            ),
          )}
        {classification &&
          entry(t("obia.steps.classify"), [
            when(classification.finishedAt),
            code(commandLine(classification.call.tool, classification.call.args)),
            classification.settings.method === "inherit"
              ? t("obia.provenance.inherit", { level: session.level + 1 })
              : classification.settings.method === "random-forest"
              ? t("obia.provenance.forest", {
                  trees: classification.settings.trees,
                  count: classification.trainingCount,
                  fields: classification.fields.length,
                })
              : t("obia.provenance.rules", {
                  count: classification.settings.rules.length,
                  defaultClass: classification.settings.defaultClass,
                }),
            env(classification.env),
          ])}
        {batches.map((run) =>
          entry(
            t("obia.provenance.batch", { name: run.source.name }),
            [
              when(run.finishedAt),
              run.source.location ?? null,
              run.area ? areaLine(run.area, run.pixelSize) : null,
              ...run.calls.map((call) => code(commandLine(call.tool, call.args))),
              env(run.env),
            ].filter(Boolean),
          ),
        )}
      </dl>
      <div className="mt-2 flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          onClick={() => void copy()}
        >
          <Copy className="h-3.5 w-3.5" />
          {t("obia.provenance.copy")}
        </Button>
        {copyStatus !== "idle" && (
          <span
            role="status"
            className={
              copyStatus === "failed" ? "text-xs text-destructive" : "text-xs text-muted-foreground"
            }
          >
            {t(copyStatus === "failed" ? "obia.provenance.copyFailed" : "obia.provenance.copied")}
          </span>
        )}
      </div>
    </details>
  );
}
