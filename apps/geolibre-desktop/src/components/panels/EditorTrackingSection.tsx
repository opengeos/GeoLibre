import {
  DEFAULT_EDITOR_IDENTITY,
  DEFAULT_EDITOR_TRACKING_CONFIG,
  readStoredAuthorName,
  setStoredAuthorName,
  useAppStore,
  type EditorTrackingConfig,
  type GeoLibreLayer,
} from "@geolibre/core";
import { Input, Label } from "@geolibre/ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAttributePropertyNames } from "../../lib/expression-inputs";
import {
  DEFAULT_EDITOR_TRACKING_NAMES,
  EDITOR_TRACKING_FIELD_KEYS,
  editorTrackingNameProblem,
  type EditorTrackingFieldKey,
} from "../../lib/editor-tracking-names";

interface EditorTrackingSectionProps {
  layer: GeoLibreLayer;
}

/**
 * The Editor Tracking section of the layer style panel (ArcGIS Layer
 * Properties → Editor Tracking): maintain who created each feature and when,
 * and who last changed it and when, across every editing path — the geometry
 * editor, attribute edits, the Field Calculator, and Field Collection capture.
 *
 * The four columns are written by the app, so the attribute table shows them
 * but refuses to edit, rename or delete them; renaming happens here, where the
 * configuration that gives them meaning lives.
 */
export function EditorTrackingSection({ layer }: EditorTrackingSectionProps) {
  const { t } = useTranslation();
  const setLayerEditorTracking = useAppStore((s) => s.setLayerEditorTracking);
  const collabActive = useAppStore((s) => s.collaboration.isActive);
  const collabName = useAppStore((s) => s.collaboration.selfName);

  const config = layer.editorTracking;
  const enabled = config?.enabled === true;
  // A live session names its participants, and that name wins over the local
  // one (see pickEditorIdentity), so the field is shown but not editable.
  const sessionIdentity = collabActive && collabName ? collabName : null;

  // `localStorage` is not reactive and the Comments panel writes the same key,
  // so this is seeded at mount and re-read whenever the field is focused. In the
  // shared-rail layout the Style panel stays mounted while collapsed, so a name
  // set from Comments would otherwise be invisible here — and worse, blurring
  // this field would write the stale value back over it.
  const [authorName, setAuthorName] = useState(() => readStoredAuthorName());

  // Field names as typed, so a half-cleared name can be retyped instead of
  // snapping back to its stored value on every keystroke.
  const [drafts, setDrafts] = useState<Record<EditorTrackingFieldKey, string> | null>(null);
  const storedNames = useMemo(
    () =>
      Object.fromEntries(
        EDITOR_TRACKING_FIELD_KEYS.map((key) => [
          key,
          config?.[key] ?? DEFAULT_EDITOR_TRACKING_CONFIG[key],
        ]),
      ) as Record<EditorTrackingFieldKey, string>,
    [config],
  );
  const names = drafts ?? storedNames;

  // The layer's own attribute columns, minus the ones tracking already
  // maintains — pointing a tracking column back at its current name is how
  // renaming works and must not read as a collision. Keyed on the data so an
  // unrelated style edit does not repeat the property scan.
  const { metadata: layerMetadata, geojson: layerGeojson } = layer;
  const dataColumns = useMemo(() => {
    const columns = new Set(
      getAttributePropertyNames({ metadata: layerMetadata, geojson: layerGeojson }),
    );
    for (const key of EDITOR_TRACKING_FIELD_KEYS) columns.delete(storedNames[key]);
    return columns;
  }, [layerMetadata, layerGeojson, storedNames]);

  const invalid = useMemo(
    () => editorTrackingNameProblem(names, dataColumns),
    [names, dataColumns],
  );

  // What to persist when the drafts are unusable: the stored names, or the
  // defaults when a hand-edited project left those broken too. Writing an
  // invalid set would be a dead end — the inputs are only rendered while
  // tracking is on, so a bad set stored on the way out leaves no way back in.
  const safeNames = invalid
    ? editorTrackingNameProblem(storedNames, dataColumns)
      ? DEFAULT_EDITOR_TRACKING_NAMES
      : storedNames
    : names;

  const write = (patch: Partial<EditorTrackingConfig>) => {
    const next: EditorTrackingConfig = {
      enabled,
      ...(Object.fromEntries(
        EDITOR_TRACKING_FIELD_KEYS.map((key) => [key, safeNames[key].trim()]),
      ) as Record<EditorTrackingFieldKey, string>),
      ...patch,
    };
    // Leave the defaults implicit: a layer that renames nothing stores just
    // `{ enabled: true }`, which keeps the project file and its diffs clean.
    for (const key of EDITOR_TRACKING_FIELD_KEYS) {
      if (next[key] === DEFAULT_EDITOR_TRACKING_CONFIG[key]) delete next[key];
    }
    // Turning tracking off keeps renamed columns configured, so switching it
    // back on resumes writing the same columns instead of starting a second
    // set beside the data already stamped. With nothing customized there is
    // nothing worth persisting, so the layer drops the key entirely.
    const customized = EDITOR_TRACKING_FIELD_KEYS.some((key) => next[key] !== undefined);
    setLayerEditorTracking(layer.id, next.enabled || customized ? next : undefined);
  };

  const toggleEnabled = (checked: boolean) => {
    // Discard unusable drafts rather than carrying them across the toggle, so
    // the inputs agree with what `write` just stored.
    if (invalid) setDrafts(null);
    write({ enabled: checked });
  };

  const commitNames = () => {
    if (invalid) return;
    setDrafts(null);
    if (enabled) write({});
  };

  return (
    <div className="space-y-3" data-testid="editor-tracking-section">
      <p className="text-sm font-semibold">{t("style.editorTracking.heading")}</p>
      <p className="text-xs text-muted-foreground">{t("style.editorTracking.description")}</p>
      <label className="flex items-center gap-2 text-xs">
        {/* Never disabled: `write` falls back to a usable name set, so the
            checkbox stays the way out of any half-typed configuration. */}
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => toggleEnabled(event.target.checked)}
        />
        <span>{t("style.editorTracking.enable")}</span>
      </label>

      {enabled && (
        <>
          <div className="space-y-1">
            <Label htmlFor={`et-identity-${layer.id}`}>{t("style.editorTracking.identity")}</Label>
            <Input
              id={`et-identity-${layer.id}`}
              value={sessionIdentity ?? authorName}
              disabled={sessionIdentity !== null}
              placeholder={DEFAULT_EDITOR_IDENTITY}
              onChange={(event) => setAuthorName(event.target.value)}
              onFocus={() => setAuthorName(readStoredAuthorName())}
              onBlur={() => setStoredAuthorName(authorName)}
            />
            <p className="text-xs text-muted-foreground">
              {sessionIdentity
                ? t("style.editorTracking.identityFromSession")
                : t("style.editorTracking.identityHint", {
                    name: authorName.trim() || DEFAULT_EDITOR_IDENTITY,
                  })}
            </p>
          </div>

          {EDITOR_TRACKING_FIELD_KEYS.map((key) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`et-${key}-${layer.id}`}>{t(`style.editorTracking.${key}`)}</Label>
              <Input
                id={`et-${key}-${layer.id}`}
                className="font-mono text-xs"
                value={names[key]}
                onChange={(event) => setDrafts({ ...names, [key]: event.target.value })}
                onBlur={commitNames}
              />
            </div>
          ))}
          {invalid && (
            <p className="text-xs text-destructive">
              {invalid.reason === "columnTaken"
                ? t("style.editorTracking.columnTaken", { name: invalid.name })
                : t(`style.editorTracking.${invalid.reason}`)}
            </p>
          )}
        </>
      )}
    </div>
  );
}
