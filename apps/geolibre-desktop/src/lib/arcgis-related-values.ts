import type { ArcGISRelatedField } from "@geolibre/plugins";

/** The text an input shows for a stored value. */
export function relatedInputText(field: ArcGISRelatedField, value: unknown): string {
  if (value == null) return "";
  if (field.kind === "date" && typeof value === "number" && Number.isFinite(value)) {
    // `datetime-local` takes local wall time without a zone.
    const date = new Date(value);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return String(value);
}

/**
 * The value to store for what the user entered. Empty input is `null`.
 * Coded values map back to the published code, keeping its type. Text that
 * does not parse is passed on unchanged, so the save check reports it rather
 * than it being silently dropped.
 */
export function relatedInputValue(field: ArcGISRelatedField, text: string): unknown {
  if (text === "") return null;
  if (field.codedValues) {
    const entry = field.codedValues.find((candidate) => String(candidate.code) === text);
    if (entry) return entry.code;
  }
  if (field.kind === "integer" || field.kind === "number") {
    const number = Number(text);
    return text.trim() !== "" && Number.isFinite(number) ? number : text;
  }
  if (field.kind === "date") {
    const time = new Date(text).getTime();
    return Number.isFinite(time) ? time : text;
  }
  return text;
}

/** Whether a stored value lies outside the field's published domain. */
export function relatedValueOutsideDomain(field: ArcGISRelatedField, value: unknown): boolean {
  if (value == null) return false;
  if (field.codedValues) return !field.codedValues.some((entry) => entry.code === value);
  if (field.min !== undefined && typeof value === "number" && value < field.min) return true;
  if (field.max !== undefined && typeof value === "number" && value > field.max) return true;
  return false;
}

/** A stored value as the records list shows it: coded names and local dates. */
export function relatedDisplayText(
  field: ArcGISRelatedField,
  value: unknown,
  locale: string,
): string {
  if (value == null) return "";
  if (field.codedValues) {
    const entry = field.codedValues.find((candidate) => candidate.code === value);
    if (entry?.name) return entry.name;
  }
  if (field.kind === "date" && typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  }
  if (typeof value === "number") return value.toLocaleString(locale);
  return String(value);
}
