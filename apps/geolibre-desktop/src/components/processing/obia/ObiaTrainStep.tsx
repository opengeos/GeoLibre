import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  OBIA_CLASS_FIELD,
  collectSamples,
  labelObjects,
  renameObjectClass,
  stratifiedHoldout,
  type ObiaClass,
} from "@geolibre/processing";
import { Button, Input } from "@geolibre/ui";
import { Eraser, Plus, Shuffle, Tag, Trash2 } from "lucide-react";
import type { FeatureCollection } from "geojson";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useObiaSession } from "../../../lib/obia/obia-session";
import { ObiaNumberField, ObiaStatus, ObiaStepHeading } from "./ObiaFields";

/** Colors handed to new classes, in order. */
export const OBIA_CLASS_PALETTE = [
  "#16a34a",
  "#2563eb",
  "#dc2626",
  "#ca8a04",
  "#9333ea",
  "#0891b2",
  "#ea580c",
  "#64748b",
];

/**
 * Style the objects layer by training label: each class filled in its color,
 * unlabeled objects left as outlines.
 */
export function labelStylePatch(layer: GeoLibreLayer, classes: readonly ObiaClass[]) {
  return {
    ...layer.style,
    vectorStyleMode: "categorized" as const,
    vectorStyleProperty: OBIA_CLASS_FIELD,
    vectorStyleStops: classes.map((cls) => ({
      value: cls.name,
      color: cls.color,
      label: cls.name,
    })),
    fillColor: "rgba(0, 0, 0, 0)",
    fillOpacity: 0.6,
  };
}

/**
 * Step 3: define land-cover classes and label objects as training or
 * validation samples. Objects are picked with GeoLibre's selection (the map
 * selection tools or the attribute table), then assigned to a class.
 */
export function ObiaTrainStep(): ReactElement | null {
  const { t } = useTranslation();
  const layers = useAppStore((s) => s.layers);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const selectedFeatureIds = useAppStore((s) => s.selectedFeatureIds);
  const segmentation = useObiaSession((s) => s.segmentation);
  const classes = useObiaSession((s) => s.classes);
  const setClasses = useObiaSession((s) => s.setClasses);
  const role = useObiaSession((s) => s.labelRole);
  const setRole = useObiaSession((s) => s.setLabelRole);

  const [holdout, setHoldout] = useState(30);
  const [seed, setSeed] = useState(42);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const objectsLayer = layers.find((layer) => layer.id === segmentation?.objectsLayerId) ?? null;
  const objects = objectsLayer?.geojson ?? null;
  const samples = useMemo(() => (objects ? collectSamples(objects) : []), [objects]);

  // Classes found on the layer (e.g. labels made before a reload) join the list.
  useEffect(() => {
    const known = new Set(classes.map((cls) => cls.name));
    const missing = [...new Set(samples.map((sample) => sample.className))].filter(
      (name) => !known.has(name),
    );
    if (!missing.length) return;
    setClasses([
      ...classes,
      ...missing.map((name, i) => ({
        name,
        color: OBIA_CLASS_PALETTE[(classes.length + i) % OBIA_CLASS_PALETTE.length],
      })),
    ]);
  }, [samples, classes, setClasses]);

  const selectedIds = useMemo(() => {
    if (!objectsLayer || selectedLayerId !== objectsLayer.id) return new Set<number>();
    return new Set(selectedFeatureIds.map(Number).filter(Number.isFinite));
  }, [objectsLayer, selectedLayerId, selectedFeatureIds]);

  const counts = useMemo(() => {
    const map = new Map<string, { training: number; validation: number }>();
    for (const sample of samples) {
      const entry = map.get(sample.className) ?? { training: 0, validation: 0 };
      entry[sample.role] += 1;
      map.set(sample.className, entry);
    }
    return map;
  }, [samples]);

  const writeObjects = useCallback(
    (next: FeatureCollection, nextClasses: readonly ObiaClass[] = classes) => {
      if (!objectsLayer) return;
      updateLayer(objectsLayer.id, {
        geojson: next,
        style: labelStylePatch(objectsLayer, nextClasses),
      });
    },
    [objectsLayer, classes, updateLayer],
  );

  const addClass = () => {
    const used = new Set(classes.map((cls) => cls.name));
    let n = classes.length + 1;
    while (used.has(t("obia.train.defaultClassName", { n }))) n += 1;
    setClasses([
      ...classes,
      {
        name: t("obia.train.defaultClassName", { n }),
        color: OBIA_CLASS_PALETTE[classes.length % OBIA_CLASS_PALETTE.length],
      },
    ]);
  };

  /** Apply a class edit; returns false when a rename is rejected. */
  const updateClass = (index: number, patch: Partial<ObiaClass>): boolean => {
    const current = classes[index];
    const name = patch.name?.trim();
    if (patch.name !== undefined) {
      if (!name || classes.some((cls, i) => i !== index && cls.name === name)) {
        setError(t("obia.train.error.duplicateName"));
        return false;
      }
    }
    setError(null);
    const next = classes.map((cls, i) =>
      i === index ? { ...cls, ...patch, name: name ?? cls.name } : cls,
    );
    setClasses(next);
    if (!objects) return true;
    const renamed =
      name && name !== current.name ? renameObjectClass(objects, current.name, name) : objects;
    writeObjects(renamed, next);
    return true;
  };

  const removeClass = (index: number) => {
    const removed = classes[index];
    const next = classes.filter((_, i) => i !== index);
    setClasses(next);
    if (!objects) return;
    const ids = new Set(
      samples.filter((s) => s.className === removed.name).map((s) => s.segmentId),
    );
    writeObjects(labelObjects(objects, ids, null), next);
  };

  const assign = (cls: ObiaClass) => {
    if (!objects || !selectedIds.size) return;
    writeObjects(labelObjects(objects, selectedIds, { className: cls.name, role }));
    setMessage(t("obia.train.assigned", { count: selectedIds.size, name: cls.name }));
  };

  const clearSelected = () => {
    if (!objects || !selectedIds.size) return;
    writeObjects(labelObjects(objects, selectedIds, null));
    setMessage(t("obia.train.cleared", { count: selectedIds.size }));
  };

  const split = () => {
    if (!objects) return;
    const held = stratifiedHoldout(samples, holdout / 100, seed);
    if (!held.size) {
      setError(t("obia.train.error.nothingToSplit"));
      return;
    }
    setError(null);
    // Relabel exactly the held-out samples, grouped by their own class (not
    // the class list), so the count reported is the count moved.
    const heldByClass = new Map<string, Set<number>>();
    for (const sample of samples) {
      if (!held.has(sample.segmentId)) continue;
      const ids = heldByClass.get(sample.className) ?? new Set<number>();
      ids.add(sample.segmentId);
      heldByClass.set(sample.className, ids);
    }
    let next = objects;
    for (const [className, ids] of heldByClass) {
      next = labelObjects(next, ids, { className, role: "validation" });
    }
    writeObjects(next);
    setMessage(t("obia.train.split", { count: held.size }));
  };

  if (!segmentation) return null;

  return (
    <section className="flex flex-col gap-3 border-t pt-3">
      <ObiaStepHeading index={3} title={t("obia.steps.train")} />
      <p className="text-xs text-muted-foreground">{t("obia.train.hint")}</p>

      <div
        className="flex items-center gap-4 text-sm"
        role="radiogroup"
        aria-label={t("obia.train.role")}
      >
        <span className="text-xs font-medium">{t("obia.train.role")}</span>
        {(["training", "validation"] as const).map((value) => (
          <label key={value} className="flex items-center gap-1.5">
            <input
              type="radio"
              name="obia-label-role"
              value={value}
              checked={role === value}
              onChange={() => setRole(value)}
            />
            {t(`obia.train.roles.${value}`)}
          </label>
        ))}
      </div>

      <p className="text-xs text-muted-foreground" data-testid="obia-selected-count">
        {t("obia.train.selected", { count: selectedIds.size })}
      </p>

      <ul className="flex flex-col gap-1.5">
        {classes.map((cls, index) => {
          const count = counts.get(cls.name) ?? { training: 0, validation: 0 };
          return (
            <li
              key={`${index}-${cls.name}`}
              className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto_auto_auto] items-center gap-1.5"
              data-testid="obia-class-row"
            >
              <input
                type="color"
                aria-label={t("obia.train.color", { name: cls.name })}
                className="h-7 w-7 cursor-pointer rounded border bg-transparent p-0.5"
                value={cls.color}
                onChange={(event) => updateClass(index, { color: event.target.value })}
              />
              <Input
                aria-label={t("obia.train.name")}
                defaultValue={cls.name}
                className="h-8"
                onBlur={(event) => {
                  if (event.target.value.trim() === cls.name) return;
                  // A rejected rename shows the class's real name again, so the
                  // field never disagrees with the list.
                  if (!updateClass(index, { name: event.target.value })) {
                    event.target.value = cls.name;
                  }
                }}
              />
              <span
                className="whitespace-nowrap text-xs tabular-nums text-muted-foreground"
                title={t("obia.train.countsTitle")}
              >
                {count.training} / {count.validation}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1 px-2"
                disabled={!selectedIds.size}
                onClick={() => assign(cls)}
                title={t("obia.train.assign", { name: cls.name })}
                aria-label={t("obia.train.assign", { name: cls.name })}
              >
                <Tag className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2"
                onClick={() => removeClass(index)}
                title={t("obia.train.remove", { name: cls.name })}
                aria-label={t("obia.train.remove", { name: cls.name })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" className="gap-1" onClick={addClass}>
          <Plus className="h-3.5 w-3.5" />
          {t("obia.train.addClass")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={!selectedIds.size}
          onClick={clearSelected}
        >
          <Eraser className="h-3.5 w-3.5" />
          {t("obia.train.clearSelected")}
        </Button>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2">
        <ObiaNumberField
          id="obia-holdout"
          label={t("obia.train.holdout")}
          value={holdout}
          onChange={(value) => setHoldout(Math.round(value))}
          min={1}
          max={90}
          step={5}
        />
        <ObiaNumberField
          id="obia-holdout-seed"
          label={t("obia.train.seed")}
          value={seed}
          onChange={(value) => setSeed(Math.round(value))}
          min={0}
          step={1}
        />
        <Button
          type="button"
          variant="outline"
          className="gap-1"
          disabled={!samples.some((s) => s.role === "training")}
          onClick={split}
        >
          <Shuffle className="h-3.5 w-3.5" />
          {t("obia.train.splitButton")}
        </Button>
      </div>

      <ObiaStatus error={error} success={message} testId="obia-train-result" />
    </section>
  );
}
