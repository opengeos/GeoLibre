import type { ObiaProcessLog } from "@geolibre/processing";
import { Button, Label } from "@geolibre/ui";
import { FileDown, FileUp, Wand2 } from "lucide-react";
import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  openLocalDataFileWithFallback,
  saveTextFileWithFallback,
} from "../../../lib/file-io/file-dialogs";
import { exampleRuleset, parseRuleset } from "../../../lib/obia/obia-ruleset-run";
import type { ObiaClassifierSettings } from "../../../lib/obia/obia-session";

/**
 * The ruleset classifier's editor: the ruleset as JSON (fuzzy class
 * descriptions and a process tree), checked as it is typed, with an example
 * to start from and loading and saving as a file.
 */
export function ObiaRulesetEditor({
  settings,
  setSettings,
  fields,
  classes,
  log,
}: {
  settings: ObiaClassifierSettings;
  setSettings: (patch: Partial<ObiaClassifierSettings>) => void;
  /** Features the ruleset may read. */
  fields: readonly string[];
  classes: readonly string[];
  /** What each process did in the last run. */
  log: ObiaProcessLog[] | null;
}): ReactElement {
  const { t } = useTranslation();
  const [fileError, setFileError] = useState<string | null>(null);
  const check = useMemo(
    () => (settings.ruleset.trim() ? parseRuleset(settings.ruleset, fields, classes) : null),
    [settings.ruleset, fields, classes],
  );

  const load = async () => {
    setFileError(null);
    try {
      const file = await openLocalDataFileWithFallback({
        accept: ".json,application/json",
        filters: [{ name: "JSON", extensions: ["json"] }],
        readText: true,
      });
      if (file?.text != null) setSettings({ ruleset: file.text });
    } catch (err) {
      setFileError(err instanceof Error ? err.message : t("obia.ruleset.loadFailed"));
    }
  };
  const save = async () => {
    setFileError(null);
    try {
      await saveTextFileWithFallback(settings.ruleset, {
        defaultName: "obia-ruleset.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
        browserTypes: [{ description: "JSON", accept: { "application/json": [".json"] } }],
        mimeType: "application/json",
      });
    } catch (err) {
      setFileError(err instanceof Error ? err.message : t("obia.ruleset.saveFailed"));
    }
  };

  return (
    <div className="grid gap-2">
      <p className="text-xs text-muted-foreground">{t("obia.ruleset.hint")}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          onClick={() => setSettings({ ruleset: exampleRuleset(classes, fields) })}
        >
          <Wand2 className="h-3.5 w-3.5" />
          {t("obia.ruleset.example")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          onClick={() => void load()}
        >
          <FileUp className="h-3.5 w-3.5" />
          {t("obia.ruleset.load")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={!settings.ruleset.trim()}
          onClick={() => void save()}
        >
          <FileDown className="h-3.5 w-3.5" />
          {t("obia.ruleset.save")}
        </Button>
      </div>
      <Label htmlFor="obia-ruleset" className="text-xs">
        {t("obia.ruleset.label")}
      </Label>
      <textarea
        id="obia-ruleset"
        data-testid="obia-ruleset"
        value={settings.ruleset}
        onChange={(event) => setSettings({ ruleset: event.target.value })}
        rows={12}
        spellCheck={false}
        dir="ltr"
        className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
      />
      <p
        className={
          check && "error" in check ? "text-xs text-destructive" : "text-xs text-muted-foreground"
        }
        data-testid="obia-ruleset-check"
      >
        {!check
          ? t("obia.ruleset.empty")
          : "error" in check
            ? check.error
            : t("obia.ruleset.valid", { count: check.ruleset.processes.length })}
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.rulesetFromCurrent}
          onChange={(event) => setSettings({ rulesetFromCurrent: event.target.checked })}
        />
        {t("obia.ruleset.fromCurrent")}
      </label>
      {fileError && <p className="text-xs text-destructive">{fileError}</p>}
      {log && log.length > 0 && (
        <ul className="grid gap-0.5 text-xs" data-testid="obia-ruleset-log">
          {log.map((entry) => (
            <li key={entry.path}>
              <span className="font-mono">{entry.path}</span> {entry.name}:{" "}
              {entry.iterations != null
                ? t("obia.ruleset.logLoop", { count: entry.changed, iterations: entry.iterations })
                : t("obia.ruleset.log", { count: entry.changed })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
