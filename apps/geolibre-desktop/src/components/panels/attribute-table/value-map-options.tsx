// The option list for a field constrained to a value map, grouping the values that fit a contingency first.

import type { TFunction } from "i18next";
import type { AttributeFormFieldConfig } from "@geolibre/core";
import type { ReactNode } from "react";

/**
 * The options of a coded-value cell. When field groups govern the field, the
 * values that fit the rest of the row come first and the others follow in a
 * second group: nothing is hidden, so a row is never stuck without a way to
 * correct another field first.
 */
export function valueMapOptions(
  valueMap: NonNullable<AttributeFormFieldConfig["valueMap"]>,
  fits: ((value: unknown) => boolean) | undefined,
  t: TFunction,
): ReactNode {
  const option = (entry: (typeof valueMap)[number]) => (
    <option key={entry.value} value={entry.value}>
      {entry.label ?? entry.value}
    </option>
  );
  if (!fits) return valueMap.map(option);
  const fitting = valueMap.filter((entry) => fits(entry.value));
  if (fitting.length === valueMap.length) return valueMap.map(option);
  const others = valueMap.filter((entry) => !fits(entry.value));
  return (
    <>
      {fitting.length ? (
        <optgroup label={t("contingentValues.fitting")}>{fitting.map(option)}</optgroup>
      ) : null}
      <optgroup label={t("contingentValues.others")}>{others.map(option)}</optgroup>
    </>
  );
}
