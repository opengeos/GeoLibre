/**
 * Reads a QGIS layer's attribute-form setup (issue #3398) into GeoLibre's own
 * form model, so a project prepared once in QGIS for QField collects data the
 * same way here: edit widgets (dropdowns, ranges, checkboxes, dates), field
 * aliases, required fields, constraint expressions and default values.
 *
 * Parsing is pure and synchronous. Dropdowns that read their entries from
 * another layer (Value Relation and Relation Reference widgets) are returned
 * as {@link QgisFormRelation} records for the caller to resolve, because that
 * needs the referenced table's rows.
 */
import {
  evaluateQgisExpression,
  parseQgisExpression,
  qgisExpressionProblem,
  qgisExpressionToMapLibre,
  type AttributeFormConfig,
  type AttributeFormFieldConfig,
  type AttributeFormValueMapEntry,
} from "@geolibre/core";
import {
  RESERVED_PROPERTY_KEYS,
  type CollectionField,
  type CollectionSchema,
  type GeometryType,
} from "./field-collection";

/** A form setting that could not be carried over, for the import report. */
export interface QgisFormImportNote {
  layerName: string;
  field: string;
  reason:
    | "default"
    | "constraint"
    | "relation"
    | "relation-empty"
    | "relation-too-large"
    | "relation-multi";
  /** What was unsupported (function names, or the parse error). */
  detail?: string;
}

/** A dropdown whose entries come from another layer's rows. */
export interface QgisFormRelation {
  /** The field on the layer being imported that shows the dropdown. */
  field: string;
  /** QGIS id of the layer the entries are read from. */
  referencedLayerId: string;
  /** Column holding the stored value. */
  keyField: string;
  /** Column holding the label, when the widget names one. */
  labelField?: string;
  /** Use the referenced layer's own display expression for the label. */
  useDisplayExpression?: boolean;
}

export interface QgisLayerForm {
  /** Absent when the layer has no form setup beyond plain text fields. */
  form?: AttributeFormConfig;
  /** Every editable field, in form order, as a Field Collection schema. */
  schema: CollectionSchema;
  relations: QgisFormRelation[];
  notes: Omit<QgisFormImportNote, "layerName">[];
}

/** QGIS writes this GUID as the stored value of a value map's NULL entry. */
const QGIS_NULL_VALUE = "{2839923C-8B7D-419E-B84B-CA2FE9B80EC7}";
/** Spin boxes without real bounds are saved with the 32-bit integer limits. */
const INT_LIMIT = 2147483647;
/** QgsFieldConstraints::Constraint bit flags. */
const CONSTRAINT_NOT_NULL = 1;
const CONSTRAINT_EXPRESSION = 4;
/** QgsFieldConstraints::ConstraintStrength: soft constraints only warn. */
const STRENGTH_SOFT = "2";

type OptionValue = string | OptionValue[] | { [key: string]: OptionValue };

/** Decode a QGIS `<Option>` tree into plain values. */
function readOption(option: Element): OptionValue {
  const type = option.getAttribute("type");
  const children = Array.from(option.children).filter((child) => child.tagName === "Option");
  if (type === "Map") {
    // Null prototype: names come from the project file, and "__proto__" must
    // be an ordinary key.
    const map: { [key: string]: OptionValue } = Object.create(null);
    for (const child of children) map[child.getAttribute("name") ?? ""] = readOption(child);
    return map;
  }
  if (type === "List" || type === "StringList") return children.map(readOption);
  return option.getAttribute("value") ?? "";
}

function widgetConfig(field: Element): { [key: string]: OptionValue } {
  const root = field.querySelector(":scope > editWidget > config > Option");
  const value = root ? readOption(root) : "";
  return typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionText(config: { [key: string]: OptionValue }, name: string): string {
  const value = config[name];
  return typeof value === "string" ? value : "";
}

function optionNumber(config: { [key: string]: OptionValue }, name: string): number | undefined {
  const raw = optionText(config, name);
  if (raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && Math.abs(value) < INT_LIMIT ? value : undefined;
}

/**
 * Read a Value Map widget's entries. QGIS has written the map two ways: a
 * list of single-entry maps (current, keeps order) and one flat map (older).
 * Either way the Option's name is the label and its value the stored value.
 */
function valueMapEntries(config: { [key: string]: OptionValue }): AttributeFormValueMapEntry[] {
  const map = config.map;
  const pairs: [string, OptionValue][] = Array.isArray(map)
    ? map.flatMap((entry) =>
        typeof entry === "object" && !Array.isArray(entry) ? Object.entries(entry) : [],
      )
    : typeof map === "object"
      ? Object.entries(map)
      : [];
  const seen = new Set<string>();
  const entries: AttributeFormValueMapEntry[] = [];
  for (const [label, raw] of pairs) {
    if (typeof raw !== "string" || raw === QGIS_NULL_VALUE || raw === "" || seen.has(raw)) continue;
    seen.add(raw);
    entries.push(label && label !== raw ? { value: raw, label } : { value: raw });
  }
  return entries;
}

function attributeMap(parent: Element | null, selector: string, key: string, value: string) {
  const map = new Map<string, string>();
  parent?.querySelectorAll(selector).forEach((element) => {
    const name = element.getAttribute(key);
    const text = element.getAttribute(value)?.trim();
    if (name && text) map.set(name, text);
  });
  return map;
}

/** Map a QGIS layer's `geometry` attribute to a capture geometry. */
export function qgisCaptureGeometry(element: Element): GeometryType | null {
  const geometry = element.getAttribute("geometry")?.toLowerCase();
  if (geometry === "point") return "point";
  if (geometry === "line") return "line";
  if (geometry === "polygon") return "polygon";
  return null;
}

/**
 * Parse one `<maplayer>`'s form setup.
 *
 * @param element - The layer's `<maplayer>` element.
 * @param relationsById - Project relations (`<relations><relation>`), by id.
 * @returns The form config, capture schema, unresolved relation dropdowns and
 *   notes about settings that were skipped.
 */
export function parseQgisLayerForm(
  element: Element,
  relationsById: ReadonlyMap<string, { referencedLayerId: string; referencedField: string }>,
): QgisLayerForm {
  const aliases = attributeMap(element, ":scope > aliases > alias", "field", "name");
  const defaults = attributeMap(element, ":scope > defaults > default", "field", "expression");
  const constraintExpressions = new Map<string, { expression: string; description: string }>();
  element.querySelectorAll(":scope > constraintExpressions > constraint").forEach((constraint) => {
    const field = constraint.getAttribute("field");
    const expression = constraint.getAttribute("exp")?.trim();
    if (field && expression) {
      constraintExpressions.set(field, {
        expression,
        description: constraint.getAttribute("desc")?.trim() ?? "",
      });
    }
  });
  const constraints = new Map<string, Element>();
  element.querySelectorAll(":scope > constraints > constraint").forEach((constraint) => {
    const field = constraint.getAttribute("field");
    if (field) constraints.set(field, constraint);
  });

  const reserved = new Set(RESERVED_PROPERTY_KEYS);
  const fields: AttributeFormFieldConfig[] = [];
  const schemaFields: CollectionField[] = [];
  const relations: QgisFormRelation[] = [];
  const notes: QgisLayerForm["notes"] = [];
  let configured = false;

  for (const fieldElement of Array.from(
    element.querySelectorAll(":scope > fieldConfiguration > field"),
  )) {
    const name = fieldElement.getAttribute("name") ?? "";
    // `fid` is the GeoPackage primary key the provider assigns on insert; it
    // is not an attribute anyone fills in.
    if (!name || name.toLowerCase() === "fid" || reserved.has(name)) continue;
    const widgetType =
      fieldElement.querySelector(":scope > editWidget")?.getAttribute("type") ?? "";
    const options = widgetConfig(fieldElement);
    const config: AttributeFormFieldConfig = { field: name, widget: "text" };
    let schemaType: CollectionField["type"] = "text";
    let meaningful = false;

    switch (widgetType) {
      case "Range": {
        config.widget = optionText(options, "Style") === "Slider" ? "range" : "number";
        const min = optionNumber(options, "Min");
        const max = optionNumber(options, "Max");
        const step = optionNumber(options, "Step");
        if (min !== undefined) config.min = min;
        if (max !== undefined) config.max = max;
        // A slider needs both ends to draw; without them it is a number box.
        if (config.widget === "range" && (min === undefined || max === undefined)) {
          config.widget = "number";
        }
        if (step !== undefined && step > 0 && config.widget === "range") config.step = step;
        schemaType = "number";
        meaningful = true;
        break;
      }
      case "ValueMap": {
        const entries = valueMapEntries(options);
        if (entries.length > 0) {
          config.widget = "valueMap";
          config.valueMap = entries;
          meaningful = true;
        }
        break;
      }
      case "CheckBox": {
        // A checkbox on a text or integer column stores the two configured
        // states ("Y"/"N"), not a boolean. The checkbox widget here only
        // stores booleans, so such a field becomes a two-entry dropdown that
        // keeps writing the values the rest of the data uses.
        const checked = optionText(options, "CheckedState");
        const unchecked = optionText(options, "UncheckedState");
        if (checked !== "" && unchecked !== "" && checked !== unchecked) {
          config.widget = "valueMap";
          config.valueMap = [{ value: checked }, { value: unchecked }];
          // Numeric states (1/0 on an integer column) keep storing numbers,
          // which the value map does on its own for all-numeric codes.
          if (![checked, unchecked].every((state) => String(Number(state)) === state)) {
            config.valueType = "string";
          }
        } else {
          config.widget = "checkbox";
        }
        meaningful = true;
        break;
      }
      case "DateTime":
        // The date picker stores a date only. A field whose format carries a
        // time (a QField timestamp defaulting to now()) stays a text field so
        // the time is kept.
        // `field_iso_format` stores a full ISO timestamp whatever the format says.
        if (
          optionText(options, "field_iso_format") !== "true" &&
          !/[Hhs]|mm|[Aa][Pp]/.test(optionText(options, "field_format"))
        ) {
          config.widget = "date";
          schemaType = "date";
          meaningful = true;
        }
        break;
      case "ValueRelation": {
        const referencedLayerId = optionText(options, "Layer");
        const keyField = optionText(options, "Key");
        // A multi-select stores a list of keys in one value, which a
        // single-choice dropdown would overwrite with one key: leave it text.
        if (optionText(options, "AllowMulti") === "true") {
          notes.push({ field: name, reason: "relation-multi" });
          break;
        }
        if (referencedLayerId && keyField) {
          relations.push({
            field: name,
            referencedLayerId,
            keyField,
            ...(optionText(options, "Value") ? { labelField: optionText(options, "Value") } : {}),
          });
        } else {
          notes.push({ field: name, reason: "relation" });
        }
        break;
      }
      case "RelationReference": {
        const relation = relationsById.get(optionText(options, "Relation"));
        if (relation) {
          relations.push({
            field: name,
            referencedLayerId: relation.referencedLayerId,
            keyField: relation.referencedField,
            useDisplayExpression: true,
          });
        } else {
          notes.push({ field: name, reason: "relation" });
        }
        break;
      }
      case "Hidden":
        // Still captured (a hidden field usually holds a default), not shown.
        config.visibilityExpression = '["literal", false]';
        meaningful = true;
        break;
      default:
        break;
    }

    const alias = aliases.get(name);
    if (alias) {
      config.alias = alias;
      meaningful = true;
    }

    const constraint = constraints.get(name);
    const flags = Number(constraint?.getAttribute("constraints") ?? 0);
    if (
      flags & CONSTRAINT_NOT_NULL &&
      constraint?.getAttribute("notnull_strength") !== STRENGTH_SOFT
    ) {
      config.required = true;
      meaningful = true;
    }
    const constraintExpression = constraintExpressions.get(name);
    if (
      constraintExpression &&
      flags & CONSTRAINT_EXPRESSION &&
      constraint?.getAttribute("exp_strength") !== STRENGTH_SOFT
    ) {
      const translated = qgisExpressionToMapLibre(constraintExpression.expression);
      if (translated) {
        // QGIS does not hold an empty value against a constraint (that is
        // what Not null is for), while the converted expression would read a
        // blank field as 0 or "" and reject it.
        config.constraintExpression = JSON.stringify([
          "any",
          ["==", ["get", name], null],
          JSON.parse(translated),
        ]);
        if (constraintExpression.description) {
          config.constraintDescription = constraintExpression.description;
        }
        meaningful = true;
      } else {
        notes.push({ field: name, reason: "constraint", detail: constraintExpression.expression });
      }
    }

    const defaultExpression =
      defaults.get(name) ?? (widgetType === "UuidGenerator" ? "uuid()" : undefined);
    if (defaultExpression) {
      const problem = qgisExpressionProblem(defaultExpression);
      if (problem === null) {
        config.defaultValue = defaultExpression;
        meaningful = true;
      } else {
        notes.push({ field: name, reason: "default", detail: problem });
      }
    }

    schemaFields.push({
      key: name,
      label: alias ?? name,
      type: schemaType,
      ...(config.required ? { required: true } : {}),
    });
    // Every field gets a config once any does, so the form keeps QGIS's order.
    fields.push(config);
    configured ||= meaningful || relations.some((relation) => relation.field === name);
  }

  return {
    ...(configured ? { form: { fields } } : {}),
    schema: { fields: schemaFields },
    relations,
    notes,
  };
}

/** Most dropdown entries a relation may produce before it is left as text. */
export const MAX_RELATION_ENTRIES = 1000;

/** A relation dropdown's entries and how its stored values are typed. */
export interface RelationValueMap {
  entries: AttributeFormValueMapEntry[];
  /**
   * `"string"` when the key column holds text, so a code such as `"01"` or
   * `"2"` is stored as text like the rows already in the layer; `"number"`
   * when every key is numeric.
   */
  valueType: "string" | "number";
}

/**
 * Turn a referenced table's rows into dropdown entries.
 *
 * @param rows - The referenced table's rows, as plain records.
 * @param relation - Which columns hold the stored value and the label.
 * @param displayExpression - The referenced layer's QGIS display expression,
 *   used for the label when the widget does not name a label column.
 * @returns Every distinct entry, sorted by label. The caller decides what to
 *   do with a list longer than {@link MAX_RELATION_ENTRIES}.
 */
export function relationValueMap(
  rows: readonly Record<string, unknown>[],
  relation: QgisFormRelation,
  displayExpression?: string,
): RelationValueMap {
  const seen = new Set<string>();
  const entries: AttributeFormValueMapEntry[] = [];
  const source = relation.useDisplayExpression ? displayExpression?.trim() : undefined;
  // Parsed once: the same expression labels every row.
  const parsed = source ? parseQgisExpression(source) : null;
  const expression = parsed?.ok ? parsed.node : null;
  let numeric = true;
  for (const row of rows) {
    const raw = row[relation.keyField];
    if (raw == null || raw === "") continue;
    const value = String(raw);
    if (seen.has(value)) continue;
    seen.add(value);
    if (typeof raw !== "number" && typeof raw !== "bigint") numeric = false;
    let label: unknown = relation.labelField ? row[relation.labelField] : undefined;
    if (label == null && expression) {
      const result = evaluateQgisExpression(expression, { properties: row });
      if (result.ok) label = result.value;
    }
    const text = label == null ? "" : String(label).trim();
    entries.push(text && text !== value ? { value, label: text } : { value });
  }
  entries.sort((a, b) =>
    (a.label ?? a.value).localeCompare(b.label ?? b.value, undefined, { numeric: true }),
  );
  return { entries, valueType: numeric ? "number" : "string" };
}
