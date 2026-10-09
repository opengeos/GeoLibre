import { Label, Select } from "@geolibre/ui";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  isNativeMethod,
  nativePixelLimit,
  type ObiaMethod,
  type ObiaNativeStatus,
} from "../../../lib/obia/obia-native";
import { useObiaSession } from "../../../lib/obia/obia-session";
import type { ObiaSourceInfo, planObiaArea } from "../../../lib/obia/obia-source";
import { ObiaNumberField } from "./ObiaFields";

/**
 * The Segment step's method choice and its parameters: seeded region growing
 * in the browser, or SLIC / Felzenszwalb natively in the sidecar.
 */
export function ObiaMethodFields({
  nativeStatus,
  nativeUsable,
}: {
  /** Native availability, or null when there is no sidecar to ask. */
  nativeStatus: ObiaNativeStatus | null;
  /** Whether a native run can start: available, on a local file. */
  nativeUsable: boolean;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const method = useObiaSession((s) => s.method);
  const setMethod = useObiaSession((s) => s.setMethod);
  const params = useObiaSession((s) => s.params);
  const setParams = useObiaSession((s) => s.setParams);
  const nativeParams = useObiaSession((s) => s.nativeParams);
  const setNativeParams = useObiaSession((s) => s.setNativeParams);
  const native = isNativeMethod(method);
  const bandCount = useObiaSession((s) => s.bandIndexes.length);

  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor="obia-method" className="text-xs">
          {t("obia.method")}
        </Label>
        <Select
          id="obia-method"
          value={method}
          onChange={(event) => setMethod(event.target.value as ObiaMethod)}
        >
          <option value="region-growing">{t("obia.methodRegionGrowing")}</option>
          <option value="slic" disabled={!nativeUsable && method !== "slic"}>
            {t("obia.native.slic")}
          </option>
          <option value="felzenszwalb" disabled={!nativeUsable && method !== "felzenszwalb"}>
            {t("obia.native.felzenszwalb")}
          </option>
        </Select>
        <p className="text-xs text-muted-foreground" data-testid="obia-method-note">
          {native
            ? nativeUsable
              ? t("obia.native.note", {
                  max: (nativeStatus && isNativeMethod(method)
                    ? nativePixelLimit(nativeStatus, method, bandCount)
                    : 0
                  ).toLocaleString(i18n.language),
                })
              : t(
                  nativeStatus === null
                    ? "obia.native.needsDesktop"
                    : !nativeStatus.available
                      ? "obia.native.unavailable"
                      : "obia.native.needsLocalFile",
                )
            : t("obia.methodNote")}
        </p>
        {!native && nativeUsable && (
          <p className="text-xs text-muted-foreground">{t("obia.native.offer")}</p>
        )}
      </div>

      {method === "region-growing" && (
        <>
          <div className="grid grid-cols-3 items-end gap-2">
            <ObiaNumberField
              id="obia-threshold"
              label={t("obia.threshold")}
              value={params.threshold}
              onChange={(threshold) => setParams({ threshold })}
              min={0.05}
              max={5}
              step={0.05}
            />
            <ObiaNumberField
              id="obia-min-area"
              label={t("obia.minArea")}
              value={params.minArea}
              onChange={(minArea) => setParams({ minArea: Math.round(minArea) })}
              min={1}
              step={1}
            />
            <ObiaNumberField
              id="obia-steps"
              label={t("obia.seedSteps")}
              value={params.steps}
              onChange={(steps) => setParams({ steps: Math.round(steps) })}
              min={1}
              max={50}
              step={1}
            />
          </div>
          <p className="-mt-1 text-xs text-muted-foreground">{t("obia.thresholdHint")}</p>
        </>
      )}
      {method === "slic" && (
        <div className="grid grid-cols-2 items-end gap-2">
          <ObiaNumberField
            id="obia-slic-size"
            label={t("obia.native.slicSize")}
            value={nativeParams.slic.size}
            onChange={(size) => setNativeParams({ slic: { size: Math.round(size) } })}
            min={4}
            step={1}
          />
          <ObiaNumberField
            id="obia-slic-compactness"
            label={t("obia.native.compactness")}
            value={nativeParams.slic.compactness}
            onChange={(compactness) => setNativeParams({ slic: { compactness } })}
            min={0.001}
            max={1000}
            step={0.01}
          />
          <p className="col-span-2 text-xs text-muted-foreground">{t("obia.native.slicHint")}</p>
        </div>
      )}
      {method === "felzenszwalb" && (
        <div className="grid grid-cols-3 items-end gap-2">
          <ObiaNumberField
            id="obia-felz-scale"
            label={t("obia.native.scale")}
            value={nativeParams.felzenszwalb.scale}
            onChange={(scale) => setNativeParams({ felzenszwalb: { scale } })}
            min={0.001}
            step={10}
          />
          <ObiaNumberField
            id="obia-felz-sigma"
            label={t("obia.native.sigma")}
            value={nativeParams.felzenszwalb.sigma}
            onChange={(sigma) => setNativeParams({ felzenszwalb: { sigma } })}
            min={0}
            max={20}
            step={0.1}
          />
          <ObiaNumberField
            id="obia-felz-min-size"
            label={t("obia.minArea")}
            value={nativeParams.felzenszwalb.minSize}
            onChange={(minSize) =>
              setNativeParams({ felzenszwalb: { minSize: Math.round(minSize) } })
            }
            min={1}
            step={1}
          />
          <p className="col-span-3 text-xs text-muted-foreground">
            {t("obia.native.felzenszwalbHint")}
          </p>
        </div>
      )}
    </>
  );
}

/** One line saying what a run will read, and at which resolution. */
export function ObiaAreaNote({
  info,
  plan,
  mode,
  maxPixels,
}: {
  info: ObiaSourceInfo;
  plan: ReturnType<typeof planObiaArea> | null;
  mode: "image" | "view";
  maxPixels: number;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const number = (value: number) => value.toLocaleString(i18n.language);
  let text: string;
  let warn = false;
  if (!plan) {
    text = t(info.toPixel ? "obia.area.outside" : "obia.area.noCrs");
    warn = true;
  } else {
    const { level } = plan.area;
    const values = {
      width: number(plan.width),
      height: number(plan.height),
      // Significant digits: a geographic pixel size is a small fraction of a degree.
      size: plan.pixelSize.toLocaleString(i18n.language, { maximumSignificantDigits: 3 }),
      unit: info.unit ?? "",
      max: number(maxPixels),
    };
    if (!plan.fits) {
      text = t("obia.area.tooLarge", values);
      warn = true;
    } else if (level === 0) {
      text = t("obia.area.full", values);
    } else {
      text = t(mode === "view" ? "obia.area.overviewView" : "obia.area.overview", values);
    }
  }
  return (
    <p
      className={warn ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
      data-testid="obia-area-note"
    >
      {text}
    </p>
  );
}
