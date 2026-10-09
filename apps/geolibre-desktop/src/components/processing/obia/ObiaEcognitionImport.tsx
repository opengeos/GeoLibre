import { Button, Label, Select } from "@geolibre/ui";
import { FileUp, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  FileTooLargeError,
  openLocalDataFileWithFallback,
} from "../../../lib/file-io/file-dialogs";
import {
  ECOGNITION_MAX_BYTES,
  EcognitionImportError,
  importEcognitionRuleset,
  parseEcognitionFile,
  type EcognitionImport,
} from "../../../lib/obia/obia-ecognition";
import { withClasses } from "../../../lib/obia/obia-import";
import { useObiaSession } from "../../../lib/obia/obia-session";
import { ObiaStatus } from "./ObiaFields";

/**
 * Import an eCognition rule set (`.dcp`) or project (`.dpr`) as a workbench
 * ruleset: map its image layers to bands, review what converted and what did
 * not, then use it in the Classify step.
 */
export function ObiaEcognitionImport(): ReactElement {
  const { t } = useTranslation();
  const bandIndexes = useObiaSession((s) => s.bandIndexes);
  const features = useObiaSession((s) => s.features);
  // The file's parsed documents: parsed once, then converted again whenever a
  // layer's band changes.
  const [file, setFile] = useState<{ name: string; docs: Document[] } | null>(null);
  const [layerBands, setLayerBands] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const errorMessage = useCallback(
    (err: unknown) =>
      err instanceof EcognitionImportError
        ? t(`obia.import.ecognition.error.${err.code}`)
        : err instanceof FileTooLargeError
          ? t("obia.import.ecognition.error.too-large")
          : t("obia.import.error.failed"),
    [t],
  );
  const result = useMemo((): EcognitionImport | string | null => {
    if (!file) return null;
    try {
      return importEcognitionRuleset(file.docs, layerBands);
    } catch (err) {
      return errorMessage(err);
    }
  }, [file, layerBands, errorMessage]);
  const report = typeof result === "string" ? null : result;

  const open = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    setFile(null);
    try {
      const picked = await openLocalDataFileWithFallback({
        accept: ".dcp,.dpr",
        filters: [{ name: "eCognition", extensions: ["dcp", "dpr"] }],
        readBinary: true,
        maxBytes: ECOGNITION_MAX_BYTES,
      });
      if (picked?.data) {
        setLayerBands({});
        setFile({
          name: picked.path.split(/[\\/]/).pop() ?? picked.path,
          docs: parseEcognitionFile(new Uint8Array(picked.data)),
        });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const use = () => {
    if (!report?.ruleset) return;
    const state = useObiaSession.getState();
    state.setClasses(withClasses(state.classes, report.classes));
    state.setClassifier({ method: "ruleset", ruleset: JSON.stringify(report.ruleset, null, 2) });
    setDone(t("obia.import.ecognition.used"));
  };

  const bands = bandIndexes.length
    ? bandIndexes
    : Array.from({ length: report?.layers.length ?? 0 }, (_, i) => i + 1);
  const notComputed = report?.fields.filter((field) => !field.computed) ?? [];
  const measured = new Set(features?.table.fields ?? []);
  const segmentation = report?.skipped.filter((item) => item.reason === "segmentation") ?? [];
  const skipped = report?.skipped.filter((item) => item.reason !== "segmentation") ?? [];

  return (
    <div className="grid gap-2 border-t pt-2" data-testid="obia-ecognition-import">
      <span className="text-xs font-medium">{t("obia.import.ecognition.title")}</span>
      <p className="text-xs text-muted-foreground">{t("obia.import.ecognition.hint")}</p>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => void open()}
          disabled={busy}
          data-testid="obia-ecognition-open"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
          {t("obia.import.ecognition.open")}
        </Button>
      </div>
      <ObiaStatus error={error ?? (typeof result === "string" ? result : null)} />
      {report && file && (
        <div className="grid gap-2 text-xs" data-testid="obia-ecognition-report">
          <p className="font-medium">
            {t("obia.import.ecognition.summary", {
              name: file.name,
              converted: report.converted,
              count: report.processCount,
            })}
          </p>
          {report.layers.length > 0 && (
            <div className="grid gap-1">
              <span className="font-medium">{t("obia.import.ecognition.layers")}</span>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                {report.layers.map((alias) => (
                  <div key={alias} className="flex min-w-0 items-center gap-2">
                    <Label
                      htmlFor={`obia-ecognition-layer-${alias}`}
                      className="min-w-0 flex-1 truncate text-xs"
                    >
                      {alias}
                    </Label>
                    <Select
                      id={`obia-ecognition-layer-${alias}`}
                      className="h-7 w-24 shrink-0"
                      value={String(report.layerBands[alias])}
                      onChange={(event) =>
                        setLayerBands((current) => ({
                          ...current,
                          [alias]: Number(event.target.value),
                        }))
                      }
                    >
                      {[...new Set([...bands, report.layerBands[alias]])].map((band) => (
                        <option key={band} value={band}>
                          {t("obia.import.ecognition.band", { band })}
                        </option>
                      ))}
                    </Select>
                  </div>
                ))}
              </div>
            </div>
          )}
          {segmentation.length > 0 && (
            <p className="text-muted-foreground">
              {t("obia.import.ecognition.segmentation", {
                names: segmentation.map((item) => `${item.name} (${item.detail})`).join("; "),
              })}
            </p>
          )}
          {report.levels.length > 1 && (
            <p className="text-muted-foreground">
              {t("obia.import.ecognition.levels", { levels: report.levels.join(", ") })}
            </p>
          )}
          {notComputed.length > 0 && (
            <p className="text-muted-foreground" data-testid="obia-ecognition-features">
              {t("obia.import.ecognition.notComputed", {
                features: notComputed
                  .map((field) =>
                    measured.has(field.field) ? `${field.feature} ✓` : field.feature,
                  )
                  .join("; "),
              })}
            </p>
          )}
          {skipped.length > 0 && (
            <details>
              <summary className="cursor-pointer">
                {t("obia.import.ecognition.skipped", { count: skipped.length })}
              </summary>
              <ul className="mt-1 grid max-h-48 gap-0.5 overflow-auto ps-3">
                {skipped.map((item) => (
                  <li key={item.path} className="break-words">
                    <span className="tabular-nums">{item.path}</span>
                    {item.name ? ` ${item.name}` : ""}:{" "}
                    {t(`obia.import.ecognition.reason.${item.reason}`)}
                    {item.detail ? ` (${item.detail})` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div>
            <Button
              type="button"
              size="sm"
              onClick={use}
              disabled={!report.ruleset}
              data-testid="obia-ecognition-use"
            >
              {t("obia.import.ecognition.use")}
            </Button>
          </div>
          {!report.ruleset && (
            <p className="text-muted-foreground">{t("obia.import.ecognition.nothing")}</p>
          )}
          <ObiaStatus error={null} success={done} testId="obia-ecognition-result" />
        </div>
      )}
    </div>
  );
}
