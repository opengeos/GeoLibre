import { useAppStore } from "@geolibre/core";
import { accuracyReportCsv, assessAccuracy, collectSamples } from "@geolibre/processing";
import { Button } from "@geolibre/ui";
import { Download, Info } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { saveTextFileWithFallback } from "../../../lib/file-io/file-dialogs";
import { useObiaSession } from "../../../lib/obia/obia-session";
import { ObiaStatus, ObiaStepHeading } from "./ObiaFields";

/** Percent in the app's UI language (not the browser locale). */
const formatPct = (value: number | null, language: string) =>
  value == null
    ? "–"
    : new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 1 }).format(value);

/** Kappa to three decimals in the app's UI language. */
const formatKappa = (value: number, language: string) =>
  new Intl.NumberFormat(language, { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(
    value,
  );

/**
 * Step 5: score the classification against the validation samples, which the
 * random forest never trained on. Updates live as samples are relabeled.
 */
export function ObiaAccuracyStep(): ReactElement | null {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const layers = useAppStore((s) => s.layers);
  const segmentation = useObiaSession((s) => s.segmentation);
  const features = useObiaSession((s) => s.features);
  const classes = useObiaSession((s) => s.classes);
  const classification = useObiaSession((s) => s.classification);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const objects = layers.find((layer) => layer.id === segmentation?.objectsLayerId)?.geojson;
  const report = useMemo(() => {
    if (!objects || !classification) return null;
    const areas = new Map<number, number>();
    for (const [id, row] of features?.table.rows ?? []) {
      if (row.area_px != null) areas.set(id, row.area_px);
    }
    return assessAccuracy(
      collectSamples(objects),
      classification.predictions,
      areas.size ? areas : undefined,
      classes.map((cls) => cls.name),
    );
  }, [objects, classification, features, classes]);

  // A relabel changes the report, so an earlier "saved" or error no longer
  // describes it.
  useEffect(() => {
    setSaved(null);
    setError(null);
  }, [report]);

  if (!segmentation || !classification || !report) return null;

  const download = async () => {
    setError(null);
    try {
      const path = await saveTextFileWithFallback(accuracyReportCsv(report), {
        defaultName: `${segmentation.sourceName.replace(/\.[^.]+$/, "")}_accuracy.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
        browserTypes: [{ description: "CSV", accept: { "text/csv": [".csv"] } }],
        mimeType: "text/csv",
      });
      if (path !== null) setSaved(t("obia.accuracy.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("obia.accuracy.error.save"));
    }
  };

  return (
    <section className="flex flex-col gap-3 border-t pt-3" data-testid="obia-accuracy">
      <ObiaStepHeading index={5} title={t("obia.steps.accuracy")} />

      {report.sampleCount === 0 ? (
        <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          {t("obia.accuracy.noValidation")}
        </p>
      ) : (
        <>
          {classification.settings.method === "rules" && (
            <p className="text-xs text-muted-foreground">{t("obia.accuracy.rulesNote")}</p>
          )}
          <dl className="grid grid-cols-3 gap-2 text-center" data-testid="obia-accuracy-summary">
            {[
              [t("obia.accuracy.overall"), formatPct(report.overallAccuracy, language)],
              [t("obia.accuracy.kappa"), formatKappa(report.kappa, language)],
              [t("obia.accuracy.areaWeighted"), formatPct(report.areaWeightedAccuracy, language)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md border p-2">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="text-base font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">
            {t("obia.accuracy.samples", { count: report.sampleCount })}
            {report.unpredicted > 0 &&
              ` ${t("obia.accuracy.unpredicted", { count: report.unpredicted })}`}
          </p>

          <div className="overflow-auto">
            <table
              className="w-full border-collapse text-xs tabular-nums"
              data-testid="obia-confusion"
            >
              <caption className="pb-1 text-start text-xs text-muted-foreground">
                {t("obia.accuracy.matrixCaption")}
              </caption>
              <thead>
                <tr>
                  <th className="border p-1 text-start font-medium" scope="col">
                    {t("obia.accuracy.referenceVsPredicted")}
                  </th>
                  {report.labels.map((name) => (
                    <th key={name} className="border p-1 font-medium" scope="col">
                      {name}
                    </th>
                  ))}
                  <th className="border p-1 font-medium" scope="col">
                    {t("obia.accuracy.producers")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.labels.map((name, i) => (
                  <tr key={name}>
                    <th className="border p-1 text-start font-medium" scope="row">
                      {name}
                    </th>
                    {report.matrix[i].map((count, j) => (
                      <td
                        key={j}
                        className={
                          i === j
                            ? "border bg-emerald-500/15 p-1 text-center font-semibold"
                            : "border p-1 text-center"
                        }
                      >
                        {count}
                      </td>
                    ))}
                    <td className="border p-1 text-center">
                      {formatPct(report.perClass[i].producers, language)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <th className="border p-1 text-start font-medium" scope="row">
                    {t("obia.accuracy.users")}
                  </th>
                  {report.perClass.map((cls) => (
                    <td key={cls.className} className="border p-1 text-center">
                      {formatPct(cls.users, language)}
                    </td>
                  ))}
                  <td className="border p-1 text-center text-muted-foreground">–</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={() => void download()}
            >
              <Download className="h-3.5 w-3.5" />
              {t("obia.accuracy.download")}
            </Button>
          </div>
        </>
      )}

      <ObiaStatus error={error} success={saved} />
    </section>
  );
}
