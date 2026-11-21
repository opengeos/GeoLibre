/**
 * The one reader of ArcGIS Pro CIM symbology: renderers, symbols and colours.
 *
 * Every importer of CIM JSON (ArcGIS Pro projects and map files today, layer
 * files next) reads symbology through this module, so a renderer, symbol or
 * colour means the same thing whichever file it arrives in. Pure and free of
 * `maplibre-gl`, like the other style importers behind
 * `@geolibre/map/style-import`.
 *
 * Public API (exported from `@geolibre/map/style-import`):
 *
 * - {@link translateCimRenderer}`(renderer)`: a feature layer's `renderer`
 *   object to style fields plus issues. The entry point for a layer.
 * - {@link translateCimSymbol}`(reference)`: one `CIMSymbolReference` to a
 *   single-symbol style, with the same issues as a simple renderer.
 * - {@link cimColor}`(color)`: one `CIMColor` to `{ hex, opacity }`, or null
 *   when it cannot be read (for label text symbols and the like).
 * - {@link cimSymbolLayerEnabled}`(layer)`: whether a symbol layer draws.
 *
 * An adapter merges `style` over its base style and turns each issue code into
 * one warning for the layer; `translated: false` means the renderer was
 * refused and `style` holds only what its single or default symbol says.
 *
 * Renderers:
 *
 * - `CIMSimpleRenderer` becomes a single-symbol style.
 * - `CIMUniqueValueRenderer` on one field becomes one rule per class.
 * - `CIMClassBreaksRenderer` of type `GraduatedColor` becomes one rule per
 *   break.
 * - Anything else is refused.
 *
 * Supported renderers produce per-layer issues for what they leave out, so
 * nothing is dropped without a warning. A refused renderer keeps any readable
 * single or default symbol, otherwise the caller's default style applies, and
 * names the reason: another renderer type (`renderer`), unique values on
 * several fields or none (`multiple-fields`), an Arcade expression
 * (`expression`), normalised breaks (`normalization`), graduated symbols
 * (`graduated-symbols`), an exclusion clause (`exclusion`), a class symbol
 * with no solid colour (`symbol`), or no usable classes or field
 * (`no-classes`). A translated renderer can still carry issues for what it
 * leaves out: visual variables (`visual-variables`), symbol layers it does
 * not draw (`symbol-layers`), a fill or outline colour it cannot read (`color`),
 * per-class stroke transparency GeoLibre's rules cannot hold
 * (`transparency`), geometric effects such as dashes or offsets
 * (`effects`), a marker shape other than a circle, which is drawn as a
 * circle (`marker-shape`), and alternate symbols for other scales, of which
 * only the primary symbol is drawn (`alternate-symbols`).
 *
 * Thematic renderers become `"rule-based"` styles rather than the native
 * `"categorized"`/`"graduated"` modes, because neither native mode can carry
 * ArcGIS semantics:
 *
 * - A class breaks class is `(previous upper bound, upper bound]`, the first
 *   one `[minimumBreak, upper bound]`. The native graduated `step` is
 *   lower-bound inclusive (`[stop, next stop)`) and paints values below the
 *   first stop, and missing values, in the first class. Feeding upper bounds
 *   into it puts every value that sits exactly on a break in the wrong class.
 * - A value ArcGIS does not classify (out of range, null, or not listed) draws
 *   with the default symbol only when `useDefaultSymbol` is on, and is not drawn
 *   otherwise. The native modes always draw it in the fallback colour.
 *
 * A rule per class keeps the class's own filter, label, colour and order, and
 * the catch-all rule carries the default symbol, switched off (so unclassified
 * features are hidden) when ArcGIS would not draw them. Unique value groups are
 * flattened into one list in group order; a group's heading is not kept.
 *
 * Rules are evaluated first match first, all in one map layer, so features
 * draw in data order whatever their class, as they do in ArcGIS Pro unless
 * symbol level drawing is switched on (not reproduced). Pro-generated
 * classes never share a value or a range, so rule order decides only the
 * legend; if hand-written CIM repeats a value across classes, the first
 * enabled matching rule wins.
 *
 * CIM JSON leaves out a property at its default (0, false, empty), so an
 * absent number reads as 0. Pro writes `visible: true` on every shown class.
 * Symbol-layer `enable` is the exception: see {@link cimSymbolLayerEnabled}.
 */

import { DEFAULT_LAYER_STYLE, rgbToHex, type LayerStyle, type VectorRule } from "@geolibre/core";

type CimObject = Record<string, unknown>;

/** CIM lengths are points; GeoLibre's are CSS pixels. */
const PIXELS_PER_POINT = 96 / 72;

/** How ArcGIS writes a null field value in a unique value class. */
const CIM_NULL_VALUE = "<Null>";

/**
 * Why a renderer, or part of it, was not carried over. `renderer` names the
 * renderer type that was left behind; the rest name the feature that made a
 * supported renderer type untranslatable (or, for `visual-variables`,
 * `symbol-layers`, `color`, `transparency`, `effects`, `marker-shape` and
 * `alternate-symbols`, the part that was dropped from an otherwise translated
 * renderer).
 */
export type CimRendererIssueCode =
  | "renderer"
  | "multiple-fields"
  | "expression"
  | "normalization"
  | "graduated-symbols"
  | "exclusion"
  | "symbol"
  | "no-classes"
  | "visual-variables"
  | "symbol-layers"
  | "color"
  | "transparency"
  | "effects"
  | "marker-shape"
  | "alternate-symbols";

export interface CimRendererIssue {
  code: CimRendererIssueCode;
  /** The CIM type involved (a renderer, symbol, layer or colour type), when there is one. */
  cimType?: string;
}

export interface CimRendererTranslation {
  /**
   * Whether the renderer was translated. When false, {@link style} holds only
   * what the renderer's single or default symbol says (empty when neither can
   * be read) and {@link issues} explains what was left behind.
   */
  translated: boolean;
  /** Style fields to merge over the layer's base style. */
  style: Partial<Omit<LayerStyle, "labels">>;
  issues: CimRendererIssue[];
}

/** A CIM colour as GeoLibre draws it. */
export interface CimColor {
  /** `#rrggbb`. */
  hex: string;
  /** 0-1, from the colour's alpha channel. */
  opacity: number;
}

/** The flat look of one CIM symbol, as far as GeoLibre can carry it. */
interface SymbolLook {
  geometry: "polygon" | "line" | "point";
  /** The class colour: the fill of a polygon or marker, the stroke of a line. */
  color: string;
  fillOpacity?: number;
  strokeColor?: string;
  strokeOpacity?: number;
  /** Stroke width in CSS pixels. */
  strokeWidth?: number;
  /** Marker radius in CSS pixels. */
  circleRadius?: number;
  /** The first enabled symbol layer type that is not drawn (a hatch, a marker line). */
  dropped?: string;
  /** The colour type of a solid fill or stroke whose colour cannot be read. */
  unreadable?: string;
  /** The first geometric effect (dashes, offset, ...) that is not drawn. */
  effect?: string;
  /** The marker type whose shape is not a circle, so drawing it as one changes it. */
  shape?: string;
}

/** One thematic class before it becomes a rule. */
interface ThematicClass {
  look: SymbolLook;
  label: string;
  filter: unknown[];
  visible: boolean;
}

/**
 * Translate a CIM renderer.
 *
 * @param renderer - The feature layer's `renderer` object (any shape; unknown
 *   input yields an untranslated result).
 */
export function translateCimRenderer(renderer: unknown): CimRendererTranslation {
  const cim = objectValue(renderer);
  const type = stringValue(cim?.type);
  if (!cim) return { translated: false, style: {}, issues: [] };
  // An untyped renderer holding one symbol is read as a simple renderer, as
  // the importer always has.
  if (type === "CIMSimpleRenderer" || (!type && cim.symbol)) return simpleRenderer(cim);
  if (type === "CIMUniqueValueRenderer") return uniqueValueRenderer(cim);
  if (type === "CIMClassBreaksRenderer") return classBreaksRenderer(cim);
  return untranslated(cim, { code: "renderer", cimType: type || undefined });
}

/**
 * Translate one `CIMSymbolReference` as a single-symbol style, exactly as a
 * simple renderer holding it would be.
 *
 * @param reference - The symbol reference (any shape).
 */
export function translateCimSymbol(reference: unknown): CimRendererTranslation {
  return simpleRenderer({ symbol: reference });
}

/**
 * Convert a CIM colour to hex plus opacity.
 *
 * Every CIMColor subclass stores its channels in a `values` array with alpha
 * last, but the channel meaning and scale differ per subclass, so the type has
 * to be read before `values` can be interpreted -- treating a CMYK or HSV
 * triple as RGB silently produces the wrong colour. Channels are per the CIM
 * spec (Esri/cim-spec docs/v3/CIMColor.md): RGB 0-255, CMYK/Gray/S/V 0-100,
 * hue 0-360, CIELAB L 0-100 with signed a/b, alpha 0-100. RGB, Gray, CMYK,
 * HSV and LAB are read. Any other subclass (HSL, XYZ, Spot, ...) returns
 * null, and so does any channel that is not a JSON number: `null`, `""`,
 * `true`, or a numeric string such as `"255"`, which Pro never writes. The
 * caller then decides what to do rather than drawing an invented colour.
 */
export function cimColor(value: unknown): CimColor | null {
  const color = objectValue(value);
  if (!color) return null;
  const type = stringValue(color.type);
  // A non-number channel (null, "", true) is refused rather than coerced:
  // `Number(null)` is 0, which would read a broken colour as black.
  const values = arrayValue(color.values).map((channel) =>
    typeof channel === "number" ? channel : Number.NaN,
  );
  if (values.some((channel) => !Number.isFinite(channel))) return null;

  let rgb: number[] | null = null;
  let alpha = 100;
  if (type === "CIMRGBColor" && values.length >= 3) {
    rgb = values.slice(0, 3);
    alpha = values[3] ?? 100;
  } else if (type === "CIMGrayColor" && values.length >= 1) {
    const level = (values[0] / 100) * 255;
    rgb = [level, level, level];
    alpha = values[1] ?? 100;
  } else if (type === "CIMCMYKColor" && values.length >= 4) {
    const k = 1 - values[3] / 100;
    rgb = values.slice(0, 3).map((channel) => 255 * (1 - channel / 100) * k);
    alpha = values[4] ?? 100;
  } else if (type === "CIMHSVColor" && values.length >= 3) {
    rgb = hsvToRgb(values[0], values[1] / 100, values[2] / 100);
    alpha = values[3] ?? 100;
  } else if (type === "CIMLABColor" && values.length >= 3) {
    rgb = labToRgb(values[0], values[1], values[2]);
    alpha = values[3] ?? 100;
  }
  if (!rgb) return null;

  const [r, g, b] = rgb.map((channel) => Math.max(0, Math.min(255, Math.round(channel))));
  return {
    hex: rgbToHex({ r, g, b }),
    opacity: Math.max(0, Math.min(1, alpha / 100)),
  };
}

/**
 * Whether a CIM symbol layer draws.
 *
 * The seven public ArcGIS Pro `.lyrx` exports checked (Pro 2.3 to 3.3) write
 * `enable` on every symbol layer, `true` or `false`, so for Pro's files this
 * is just the flag. CIM written by other tools sometimes leaves the flag out on
 * layers that are meant to draw, so an absent flag counts as enabled and only
 * an explicit `false` switches a layer off.
 */
export function cimSymbolLayerEnabled(layer: unknown): boolean {
  return isObject(layer) && layer.enable !== false;
}

function simpleRenderer(renderer: CimObject): CimRendererTranslation {
  const look = symbolLook(renderer.symbol);
  if (!look) return untranslated(renderer, symbolIssue(renderer.symbol));
  return {
    translated: true,
    style: { ...flatStyle(look), vectorStyleMode: "single" },
    issues: partialIssues(renderer, [look]),
  };
}

/**
 * A single-field unique value renderer: one rule per class, matching any of
 * the class's values, in the renderer's group and class order.
 */
function uniqueValueRenderer(renderer: CimObject): CimRendererTranslation {
  // CIM: "When both Fields and ValueExpressionInfo are present
  // ValueExpressionInfo is used", so an Arcade expression wins even when a
  // field is also listed.
  if (objectValue(renderer.valueExpressionInfo)) {
    return untranslated(renderer, { code: "expression" });
  }
  const fields = arrayValue(renderer.fields).filter(
    (field): field is string => typeof field === "string" && field.length > 0,
  );
  if (fields.length !== 1) return untranslated(renderer, { code: "multiple-fields" });
  const field = fields[0];

  const classes: ThematicClass[] = [];
  const groups = arrayValue(renderer.groups).filter(isObject);
  // Pro writes `visible` on every class, so where a renderer has it at all, a
  // class without it was saved unchecked (false is left out). Files from
  // before the property existed have it on no class, and every class shows.
  const writesVisible = groups.some((group) =>
    arrayValue(group.classes).some((valueClass) => isObject(valueClass) && "visible" in valueClass),
  );
  for (const group of groups) {
    for (const valueClass of arrayValue(group.classes).filter(isObject)) {
      // Pro writes every value as a string; a number from hand-written CIM is
      // read as its text, which is what ArcGIS would have stored.
      const values = arrayValue(valueClass.values)
        .filter(isObject)
        .map((value) => arrayValue(value.fieldValues)[0])
        .map((value) =>
          typeof value === "number" && Number.isFinite(value) ? String(value) : value,
        )
        .filter((value): value is string => typeof value === "string");
      // A class with no values matches nothing in ArcGIS either.
      if (values.length === 0) continue;
      const look = symbolLook(valueClass.symbol);
      if (!look) return untranslated(renderer, symbolIssue(valueClass.symbol));
      classes.push({
        look,
        label: stringValue(valueClass.label) || values.join(", "),
        filter: uniqueValueFilter(field, values),
        visible: writesVisible ? valueClass.visible === true : true,
      });
    }
  }
  if (classes.length === 0) return untranslated(renderer, { code: "no-classes" });
  return thematicStyle(renderer, classes);
}

/**
 * A graduated colour class breaks renderer: one rule per break, each covering
 * `(previous upper bound, upper bound]`, the first `[minimumBreak, upper bound]`.
 */
function classBreaksRenderer(renderer: CimObject): CimRendererTranslation {
  if (objectValue(renderer.valueExpressionInfo)) {
    return untranslated(renderer, { code: "expression" });
  }
  const breakType = stringValue(renderer.classBreakType) || "GraduatedColor";
  if (breakType === "GraduatedSymbol") {
    return untranslated(renderer, { code: "graduated-symbols" });
  }
  if (breakType !== "GraduatedColor") {
    return untranslated(renderer, { code: "renderer", cimType: breakType });
  }
  const normalization = stringValue(renderer.normalizationType);
  if (normalization && normalization !== "Nothing") {
    return untranslated(renderer, { code: "normalization" });
  }
  // Excluded features are hidden (or drawn with their own symbol) by a SQL
  // clause GeoLibre cannot evaluate, so the classes alone would draw them.
  if (stringValue(renderer.exclusionClause).trim()) {
    return untranslated(renderer, { code: "exclusion" });
  }
  const field = stringValue(renderer.field);
  const breaks = arrayValue(renderer.breaks).filter(isObject);
  // An upper bound or minimum of 0 is left out of the file, like any default.
  // A bound that is present but not a number is refused, not read as 0.
  const bound = (owner: CimObject, key: string) =>
    owner[key] === undefined ? 0 : numberValue(owner[key]);
  const uppers = breaks.map((classBreak) => bound(classBreak, "upperBound"));
  const minimumBreak = bound(renderer, "minimumBreak");
  if (
    !field ||
    breaks.length === 0 ||
    minimumBreak === null ||
    !uppers.every((upper): upper is number => upper !== null) ||
    minimumBreak > uppers[0] ||
    uppers.some((upper, index) => index > 0 && upper <= uppers[index - 1])
  ) {
    return untranslated(renderer, { code: "no-classes" });
  }

  const classes: ThematicClass[] = [];
  for (const [index, classBreak] of breaks.entries()) {
    const look = symbolLook(classBreak.symbol);
    if (!look) return untranslated(renderer, symbolIssue(classBreak.symbol));
    const upper = uppers[index];
    const lower = index === 0 ? minimumBreak : uppers[index - 1];
    classes.push({
      look,
      label: stringValue(classBreak.label) || `${formatBound(lower)} – ${formatBound(upper)}`,
      filter: classBreakFilter(field, lower, index === 0, upper),
      visible: true,
    });
  }
  // The classes are disjoint, so their order only decides the legend.
  if (renderer.showInAscendingOrder === false) classes.reverse();
  return thematicStyle(renderer, classes);
}

/**
 * Build the rule-based style shared by both thematic renderers.
 *
 * The layer's flat stroke, opacity and radius come from the first class, as
 * QGIS and the QML importer do; a class whose symbol differs keeps the
 * difference as a per-rule override, so outlines and sizes survive per class.
 */
function thematicStyle(renderer: CimObject, classes: ThematicClass[]): CimRendererTranslation {
  const base = classes[0].look;
  // `isDefaultSymbolVisible` is the "all other values" class's own checkbox
  // in the unique values table. Files from Pro 3.3 and earlier leave it out
  // while drawing the default, so only an explicit false hides the class.
  const showDefault =
    renderer.useDefaultSymbol === true && renderer.isDefaultSymbolVisible !== false;
  // Read even when it is off, so the switched-off catch-all keeps the colour
  // ArcGIS would use if the user turns it back on.
  const defaultLook = symbolLook(renderer.defaultSymbol);
  // ArcGIS draws unclassified features with the default symbol only when it
  // is switched on; a default it asks for but GeoLibre cannot read would hide
  // them instead, so the whole renderer is reported rather than half-applied.
  if (showDefault && !defaultLook) {
    return untranslated(renderer, symbolIssue(renderer.defaultSymbol));
  }
  const defaultLabel = stringValue(renderer.defaultLabel);
  const drawnDefault = showDefault ? defaultLook : null;

  const rules: VectorRule[] = classes.map((entry, index) => ({
    id: `cim-class-${index}`,
    label: entry.label,
    filter: JSON.stringify(entry.filter),
    color: entry.look.color,
    isElse: false,
    // An unchecked class in ArcGIS Pro hides its features; a disabled rule is
    // the same switch in GeoLibre's rule editor.
    ...(entry.visible ? {} : { enabled: false }),
    ...lookOverrides(entry.look, base),
  }));

  if (drawnDefault && classes.some((entry) => !entry.visible)) {
    // A disabled rule's features fall through to the catch-all, but ArcGIS
    // hides a hidden class's features even when "all other values" draws.
    // Writing the default as an explicit "none of the classes" rule and
    // switching the catch-all off keeps both behaviours. The legend shows a
    // catch-all without a label as "Other"; this rule needs the same, or its
    // filter JSON is shown instead.
    rules.push(
      {
        id: "cim-default",
        label: defaultLabel || "Other",
        filter: JSON.stringify(["!", ["any", ...classes.map((entry) => entry.filter)]]),
        color: drawnDefault.color,
        isElse: false,
        ...lookOverrides(drawnDefault, base),
      },
      {
        id: "cim-else",
        label: "",
        filter: "",
        color: base.color,
        isElse: true,
        enabled: false,
      },
    );
  } else {
    rules.push({
      id: "cim-else",
      label: defaultLabel,
      filter: "",
      color: (defaultLook ?? base).color,
      isElse: true,
      ...(defaultLook ? lookOverrides(defaultLook, base) : {}),
      ...(drawnDefault ? {} : { enabled: false }),
    });
  }

  const style = flatStyle(base);
  // The flat fill/stroke colour is what a rule falls back to; keep it on the
  // default symbol so a user switching the layer back to a single symbol sees
  // the colour ArcGIS used for unclassified features.
  if (defaultLook) {
    if (base.geometry === "line") style.strokeColor = defaultLook.color;
    else style.fillColor = defaultLook.color;
  }
  return {
    translated: true,
    style: { ...style, vectorStyleMode: "rule-based", vectorRules: rules },
    issues: partialIssues(renderer, [
      ...classes.map((entry) => entry.look),
      ...(drawnDefault ? [drawnDefault] : []),
    ]),
  };
}

/**
 * A MapLibre filter matching any of a class's unique values.
 *
 * ArcGIS stores every value as a string, whatever the field type, so the
 * feature value is compared as a string as well (`to-string` of the number 3
 * is `"3"`, matching a numeric field's stored `"3"`). `<Null>` matches a null
 * or missing value; it is kept apart from the string comparison because
 * `to-string` of null is `""`, which would otherwise also match an empty-text
 * category.
 */
function uniqueValueFilter(field: string, values: string[]): unknown[] {
  const get = ["get", field];
  const conditions: unknown[][] = [];
  const text = [...new Set(values.filter((value) => value !== CIM_NULL_VALUE))];
  if (values.includes(CIM_NULL_VALUE)) conditions.push(["==", get, null]);
  if (text.length > 0) {
    // `in` rather than `match`: `match` keeps its labels in a plain object, so
    // a value named like an `Object.prototype` key (`toString`) is rejected.
    const listed = ["in", ["to-string", get], ["literal", text]];
    conditions.push(text.includes("") ? ["all", ["!=", get, null], listed] : listed);
  }
  // `to-string` spells a number canonically (`1`, `1e+21`, `0`), so a stored
  // number spelled any other way (`1.0`, `1E+21`, `-0`) is also compared as a
  // number, against numeric feature values only, so text "1.0" still needs
  // the exact text.
  const respelled = [
    ...new Set(
      text
        .filter((value) => value.trim() !== "" && Number.isFinite(Number(value)))
        .filter((value) => String(Number(value)) !== value)
        .map(Number),
    ),
  ];
  if (respelled.length > 0) {
    conditions.push([
      "all",
      ["==", ["typeof", get], "number"],
      ["any", ...respelled.map((number) => ["==", get, number])],
    ]);
  }
  return conditions.length === 1 ? conditions[0] : ["any", ...conditions];
}

/**
 * A MapLibre filter for one class break. Only numeric values classify: ArcGIS
 * leaves a null out of every class, and `to-number` would turn it into 0.
 *
 * @param lower - The class's lower bound.
 * @param lowerInclusive - True for the first class, whose minimum belongs to it.
 */
function classBreakFilter(
  field: string,
  lower: number,
  lowerInclusive: boolean,
  upper: number,
): unknown[] {
  const value = ["to-number", ["get", field]];
  return [
    "all",
    ["==", ["typeof", ["get", field]], "number"],
    [lowerInclusive ? ">=" : ">", value, lower],
    ["<=", value, upper],
  ];
}

function untranslated(renderer: CimObject, issue: CimRendererIssue): CimRendererTranslation {
  // The renderer cannot be carried, but its single or default symbol can still
  // give the layer a colour rather than GeoLibre's generic default.
  const look = symbolLook(renderer.symbol) ?? symbolLook(renderer.defaultSymbol);
  return {
    translated: false,
    style: look ? { ...flatStyle(look), vectorStyleMode: "single" } : {},
    issues: [issue],
  };
}

function symbolIssue(reference: unknown): CimRendererIssue {
  const type = stringValue(objectValue(objectValue(reference)?.symbol)?.type);
  return { code: "symbol", ...(type ? { cimType: type } : {}) };
}

/**
 * What a translated renderer leaves out: visual variables, undrawn symbol
 * layers, unreadable colours, stroke transparency a class cannot draw with (a
 * rule can override a stroke's colour and width but not its opacity, so every
 * outline and line draws at the layer's one shared stroke opacity), and
 * geometric effects.
 */
function partialIssues(renderer: CimObject, looks: SymbolLook[]): CimRendererIssue[] {
  const issues: CimRendererIssue[] = [];
  if (arrayValue(renderer.visualVariables).length > 0) issues.push({ code: "visual-variables" });
  const dropped = looks.find((look) => look.dropped)?.dropped;
  if (dropped) issues.push({ code: "symbol-layers", cimType: dropped });
  const unreadable = looks.find((look) => look.unreadable)?.unreadable;
  if (unreadable) issues.push({ code: "color", cimType: unreadable });
  // Every class draws its stroke at the layer's opacity, which the first look
  // sets (or leaves at the default when it has no stroke).
  const inherited = looks[0]?.strokeOpacity ?? DEFAULT_LAYER_STYLE.strokeOpacity;
  const differs = looks.some(
    (look) =>
      look.strokeWidth !== 0 &&
      (look.strokeOpacity ?? DEFAULT_LAYER_STYLE.strokeOpacity) !== inherited,
  );
  if (differs) issues.push({ code: "transparency" });
  const effect = looks.find((look) => look.effect)?.effect;
  if (effect) issues.push({ code: "effects", cimType: effect });
  const shape = looks.find((look) => look.shape)?.shape;
  if (shape) issues.push({ code: "marker-shape", cimType: shape });
  // A renderer, class or break can carry alternate symbols that ArcGIS Pro
  // draws at other scales; only the primary symbol is imported.
  const classes = [
    ...arrayValue(renderer.groups)
      .filter(isObject)
      .flatMap((group) => arrayValue(group.classes)),
    ...arrayValue(renderer.breaks),
  ].filter(isObject);
  if ([renderer, ...classes].some((owner) => arrayValue(owner.alternateSymbols).length > 0)) {
    issues.push({ code: "alternate-symbols" });
  }
  return issues;
}

/** The layer-level style one symbol implies. */
function flatStyle(look: SymbolLook): Partial<Omit<LayerStyle, "labels">> {
  const style: Partial<Omit<LayerStyle, "labels">> = {};
  if (look.geometry === "line") {
    style.strokeColor = look.color;
  } else {
    style.fillColor = look.color;
    if (look.fillOpacity !== undefined) style.fillOpacity = look.fillOpacity;
    if (look.strokeColor !== undefined) style.strokeColor = look.strokeColor;
  }
  if (look.strokeOpacity !== undefined) style.strokeOpacity = look.strokeOpacity;
  if (look.strokeWidth !== undefined) style.strokeWidth = look.strokeWidth;
  if (look.circleRadius !== undefined) style.circleRadius = look.circleRadius;
  return style;
}

/** The per-rule overrides where a class's symbol differs from the base one. */
function lookOverrides(look: SymbolLook, base: SymbolLook): Partial<VectorRule> {
  const differs = (a: number | undefined, b: number | undefined) =>
    a !== undefined && (b === undefined || Math.abs(a - b) > 1e-9);
  return {
    ...(look.geometry !== "line" &&
    look.strokeColor !== undefined &&
    look.strokeColor !== base.strokeColor
      ? { strokeColor: look.strokeColor }
      : {}),
    ...(differs(look.strokeWidth, base.strokeWidth) ? { strokeWidth: look.strokeWidth } : {}),
    ...(look.geometry !== "line" && differs(look.fillOpacity, base.fillOpacity)
      ? { fillOpacity: look.fillOpacity }
      : {}),
    ...(differs(look.circleRadius, base.circleRadius) ? { circleRadius: look.circleRadius } : {}),
  };
}

/** What one pass over a symbol's enabled layers found. */
interface LayerScan {
  fill?: CimColor;
  stroke?: { color: CimColor; width: number };
  dropped?: string;
  unreadable?: string;
  effect?: string;
}

const SOLID_LAYERS = ["CIMSolidFill", "CIMSolidStroke"] as const;

/**
 * Read a `CIMSymbolReference` into a {@link SymbolLook}, or null when the
 * symbol carries no colour GeoLibre can draw (a picture, hatch or gradient
 * fill, or a marker whose drawn graphic has no readable fill, for example).
 */
function symbolLook(reference: unknown): SymbolLook | null {
  const symbol = objectValue(objectValue(reference)?.symbol);
  const layers = enabledLayers(symbol);
  const type = stringValue(symbol?.type) || inferredSymbolType(layers);
  const look =
    type === "CIMPolygonSymbol"
      ? polygonLook(scanLayers(layers, SOLID_LAYERS))
      : type === "CIMLineSymbol"
        ? lineLook(scanLayers(layers, ["CIMSolidStroke"]))
        : type === "CIMPointSymbol"
          ? markerLook(layers)
          : null;
  if (!look) return null;
  // When a layer that was left out (dropped or unreadable) is all that would
  // show, as with a hatch over a clear background, a transparent top stroke
  // over a dropped casing, or a clear marker graphic over a second one, the
  // symbol is refused rather than imported invisible. A symbol made only of
  // supported layers that is itself transparent is kept, as ArcGIS draws
  // nothing for it either.
  if ((look.dropped || look.unreadable) && !looksVisible(look)) return null;
  // Geometric effects (dashes, offsets, buffers and so on) change the shape
  // that is drawn, which a flat style cannot reproduce, so they are reported.
  const effect = firstEffect(symbol) ?? look.effect;
  return effect ? { ...look, effect } : look;
}

/**
 * One pass over enabled symbol layers, listed top-most first in CIM. The first
 * layer of each `drawn` type is drawn, as the one the user sees; any other
 * enabled layer is dropped, so a second solid stroke (the casing of a cased
 * line, say) counts as dropped too. A drawn layer whose colour cannot be read
 * is noted as unreadable rather than treated as absent.
 */
function scanLayers(layers: CimObject[], drawn: readonly string[]): LayerScan {
  const scan: LayerScan = {};
  const remaining = new Set(drawn);
  for (const layer of layers) {
    const type = stringValue(layer.type);
    scan.effect ??= layerEffect(layer);
    if (!remaining.delete(type)) {
      scan.dropped ??= type || "symbol layer";
      continue;
    }
    const color = cimColor(layer.color);
    if (!color) scan.unreadable ??= colorType(layer);
    else if (type === "CIMSolidFill") scan.fill = color;
    // ArcGIS Pro always writes a stroke's width, 0 included. An absent one
    // (from other tools) reads as 0 rather than inheriting another class's
    // outline or GeoLibre's default.
    else scan.stroke = { color, width: numberValue(layer.width) ?? 0 };
  }
  return scan;
}

/** The parts of a look a scan carries regardless of geometry. */
function scanNotes(scan: LayerScan): Pick<SymbolLook, "dropped" | "unreadable" | "effect"> {
  return {
    ...(scan.dropped ? { dropped: scan.dropped } : {}),
    ...(scan.unreadable ? { unreadable: scan.unreadable } : {}),
    ...(scan.effect ? { effect: scan.effect } : {}),
  };
}

function polygonLook(scan: LayerScan): SymbolLook | null {
  // An outline-only polygon is hollow. A polygon whose only fill is one
  // GeoLibre cannot draw flat (hatch, picture, gradient) or cannot read keeps
  // its outline, and the fill is reported (see {@link symbolLook} for when
  // nothing visible is left).
  const color = scan.fill ?? scan.stroke?.color;
  if (!color) return null;
  const stroke = strokeLook(scan.stroke);
  return {
    geometry: "polygon",
    color: color.hex,
    fillOpacity: scan.fill?.opacity ?? 0,
    ...stroke,
    // GeoLibre's fill draws a 1px hairline in the stroke colour even at width
    // 0 (QGIS reads a width of 0 as a 1px pen too), so a polygon without an
    // outline takes its own fill colour as the stroke colour. That hairline
    // then matches the edge MapLibre draws for a fill with no outline colour.
    ...(stroke.strokeWidth === 0 ? { strokeColor: color.hex } : {}),
    ...scanNotes(scan),
  };
}

/**
 * Whether a look draws anything: a stroke, or a visible fill (not for lines,
 * and not for a marker of size 0).
 */
function looksVisible(look: SymbolLook): boolean {
  const fillShows =
    look.geometry !== "line" &&
    (look.fillOpacity ?? 1) > 0 &&
    (look.geometry !== "point" || (look.circleRadius ?? DEFAULT_LAYER_STYLE.circleRadius) > 0);
  return fillShows || look.strokeWidth !== 0;
}

function lineLook(scan: LayerScan): SymbolLook | null {
  if (!scan.stroke) return null;
  return {
    geometry: "line",
    color: scan.stroke.color.hex,
    ...strokeLook(scan.stroke),
    ...scanNotes(scan),
  };
}

/**
 * A marker as a circle. The circle takes its fill and outline from the
 * marker's first graphic that draws anything; that graphic needs a readable
 * fill (or the marker its own colour), so an outline-only graphic is refused
 * rather than drawn as an empty ring. Anything beyond the one fill and outline
 * is reported: another layer beside the marker, a second drawing graphic
 * (inspected on its own, so it is reported whatever its layer types), a
 * hatch inside the drawn graphic, or a shape that is not a circle (a
 * character marker's glyph, or a drawn graphic with any other geometry or
 * none).
 */
function markerLook(layers: CimObject[]): SymbolLook | null {
  const marker = layers.find(isMarkerLayer);
  if (!marker) return null;
  const graphics = markerGraphicSymbols(marker);
  const drawing = graphics.filter((graphic) => enabledLayers(graphic).length > 0);
  const scan = scanLayers(enabledLayers(drawing[0]), SOLID_LAYERS);
  const markerColor = cimColor(marker.color);
  const fill = markerColor ?? scan.fill;
  if (!fill) return null;
  const outer = layers.find((layer) => layer !== marker);
  // ArcGIS Pro always writes a marker's size. An absent one (from other
  // tools) reads as 0, a marker that draws nothing, rather than inheriting
  // another class's size or GeoLibre's default.
  const size = numberValue(marker.size) ?? 0;
  const dropped = outer
    ? stringValue(outer.type) || "symbol layer"
    : drawing.length > 1
      ? "CIMMarkerGraphic"
      : scan.dropped;
  const unreadable =
    marker.color !== undefined && !markerColor ? colorType(marker) : scan.unreadable;
  // A marker offset moves the marker off its point, which a circle layer
  // cannot draw, so it is reported with the geometric effects.
  const offset =
    (numberValue(marker.offsetX) ?? 0) !== 0 || (numberValue(marker.offsetY) ?? 0) !== 0;
  const effect = layers.map(layerEffect).find(Boolean) ?? (offset ? "marker offset" : undefined);
  // Only a shape confirmed as a circle goes unreported: a graphic without a
  // geometry, or a marker with no drawing graphic, has no known shape.
  const drawingGraphics = arrayValue(marker.markerGraphics)
    .filter(isObject)
    .filter((graphic) => enabledLayers(objectValue(graphic.symbol)).length > 0);
  const circle =
    marker.type === "CIMVectorMarker" &&
    drawingGraphics.length > 0 &&
    drawingGraphics.every((graphic) => isCircle(graphic.geometry));
  return {
    geometry: "point",
    ...(circle ? {} : { shape: stringValue(marker.type) || "marker" }),
    color: fill.hex,
    fillOpacity: fill.opacity,
    // A size-0 marker draws nothing in ArcGIS Pro, outline included, while a
    // circle's stroke would still draw a ring around a radius of 0.
    ...strokeLook(size > 0 ? scaledStroke(marker, size, scan.stroke) : undefined),
    ...scanNotes({ dropped, unreadable, effect }),
    // A CIM marker size is its height in points; a GeoLibre circle radius is
    // half the diameter in pixels.
    circleRadius: round((size * PIXELS_PER_POINT) / 2),
  };
}

/**
 * A vector marker's outline at the marker's size. With
 * `scaleSymbolsProportionally`, the graphic's stroke widths are given at the
 * size of its `frame` and scale with the marker, so a 1pt outline in a 10pt
 * frame is 2pt on a 20pt marker. Without a readable frame the width is kept
 * as written.
 */
function scaledStroke(
  marker: CimObject,
  size: number,
  stroke: LayerScan["stroke"],
): LayerScan["stroke"] {
  if (!stroke || marker.scaleSymbolsProportionally !== true) return stroke;
  const frame = objectValue(marker.frame);
  const height =
    (numberValue(frame?.ymax) ?? Number.NaN) - (numberValue(frame?.ymin) ?? Number.NaN);
  if (!(height > 0)) return stroke;
  return { ...stroke, width: (stroke.width * size) / height };
}

function isMarkerLayer(layer: CimObject): boolean {
  return /Marker$/.test(stringValue(layer.type));
}

/**
 * The symbols a marker draws with: each vector marker graphic's symbol, and a
 * character marker's glyph symbol.
 */
function markerGraphicSymbols(marker: CimObject): CimObject[] {
  return [
    ...arrayValue(marker.markerGraphics)
      .filter(isObject)
      .map((graphic) => objectValue(graphic.symbol)),
    objectValue(marker.symbol),
  ].filter((graphic): graphic is CimObject => graphic !== undefined);
}

/**
 * The first geometric effect on a symbol layer, including, for a marker, those
 * on its graphics and their enabled layers (even when the marker itself is
 * not drawn, as with markers along a line).
 */
function layerEffect(layer: CimObject): string | undefined {
  if (!isMarkerLayer(layer)) return firstEffect(layer);
  return [
    layer,
    ...markerGraphicSymbols(layer).flatMap((graphic) => [graphic, ...enabledLayers(graphic)]),
  ]
    .map(firstEffect)
    .find(Boolean);
}

/**
 * Whether a marker graphic's geometry is a full circle as ArcGIS Pro writes
 * one: a single curve ring holding its start point and one arc (`a`) that ends
 * back at that point. A rounded square or any other curved shape has more
 * segments, and a polygon is written as `rings`. An elliptic arc is written
 * with seven elements, the last its minor-to-major axis ratio, so a closed
 * ellipse counts only when that ratio is 1.
 */
function isCircle(geometry: unknown): boolean {
  const rings = objectValue(geometry)?.curveRings;
  if (!Array.isArray(rings) || rings.length !== 1) return false;
  const ring = rings[0];
  if (!Array.isArray(ring) || ring.length !== 2) return false;
  const [start, segment] = ring;
  const arc = objectValue(segment)?.a;
  return (
    Array.isArray(start) &&
    Array.isArray(arc) &&
    Array.isArray(arc[0]) &&
    arc[0][0] === start[0] &&
    arc[0][1] === start[1] &&
    (arc.length < 7 || arc[6] === 1)
  );
}

/** The type of the first geometric effect on a symbol or symbol layer. */
function firstEffect(owner: CimObject | undefined): string | undefined {
  const effect = arrayValue(owner?.effects).find(isObject);
  return effect ? stringValue(effect.type) || "geometric effect" : undefined;
}

/** The colour type a layer's unreadable colour reports: its subclass, else the layer type. */
function colorType(owner: CimObject): string {
  return stringValue(objectValue(owner.color)?.type) || stringValue(owner.type) || "CIMColor";
}

/** The symbol type an untyped symbol's layers imply. */
function inferredSymbolType(layers: CimObject[]): string {
  const types = layers.map((layer) => stringValue(layer.type));
  if (types.some((type) => /Marker$/.test(type))) return "CIMPointSymbol";
  if (types.some((type) => /Fill$/.test(type))) return "CIMPolygonSymbol";
  if (types.some((type) => /Stroke$/.test(type))) return "CIMLineSymbol";
  return "";
}

function enabledLayers(symbol: CimObject | undefined): CimObject[] {
  return arrayValue(symbol?.symbolLayers).filter(isObject).filter(cimSymbolLayerEnabled);
}

/**
 * The stroke part of a look. A symbol with no stroke, or a fully transparent
 * one (Pro's "no colour" outline), gets a zero width: leaving the width out
 * would let the class inherit another class's outline, or GeoLibre's default.
 */
function strokeLook(
  stroke: LayerScan["stroke"],
): Pick<SymbolLook, "strokeColor" | "strokeOpacity" | "strokeWidth"> {
  if (!stroke || stroke.color.opacity === 0) return { strokeWidth: 0 };
  return {
    strokeColor: stroke.color.hex,
    ...(stroke.color.opacity !== DEFAULT_LAYER_STYLE.strokeOpacity
      ? { strokeOpacity: stroke.color.opacity }
      : {}),
    strokeWidth: round(stroke.width * PIXELS_PER_POINT),
  };
}

/**
 * CIELAB (D50, as ICC and CSS `lab()` use it) to sRGB for {@link cimColor}.
 *
 * @returns Red, green, and blue channels on a 0-255 scale (unclamped).
 */
function labToRgb(l: number, a: number, b: number): number[] {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const epsilon = 216 / 24389;
  const kappa = 24389 / 27;
  const finv = (f: number) => (f ** 3 > epsilon ? f ** 3 : (116 * f - 16) / kappa);
  const x = (finv(fx) * 0.3457) / 0.3585;
  const y = l > kappa * epsilon ? fy ** 3 : l / kappa;
  const z = (finv(fz) * (1 - 0.3457 - 0.3585)) / 0.3585;
  // Bradford-adapted D50 XYZ to linear sRGB (CSS Color 4).
  const linear = [
    3.1341359569958707 * x - 1.6173863321612538 * y - 0.4906619460083532 * z,
    -0.978795502912089 * x + 1.916254567259524 * y + 0.03344273116131949 * z,
    0.07195537988411677 * x - 0.2289768264158322 * y + 1.405386058324125 * z,
  ];
  return linear.map((channel) => {
    const magnitude = Math.abs(channel);
    const encoded =
      magnitude <= 0.0031308 ? 12.92 * magnitude : 1.055 * magnitude ** (1 / 2.4) - 0.055;
    return Math.sign(channel) * encoded * 255;
  });
}

/**
 * Standard HSV to RGB conversion for {@link cimColor}.
 *
 * @param hue - Hue in degrees; wrapped into 0-360.
 * @param saturation - Saturation as a 0-1 fraction.
 * @param value - Value as a 0-1 fraction.
 * @returns Red, green, and blue channels on a 0-255 scale.
 */
function hsvToRgb(hue: number, saturation: number, value: number): number[] {
  const h = (((hue % 360) + 360) % 360) / 60;
  const v = Math.max(0, Math.min(1, value));
  const chroma = v * Math.max(0, Math.min(1, saturation));
  const second = chroma * (1 - Math.abs((h % 2) - 1));
  const sector = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ][Math.min(5, Math.floor(h))];
  return sector.map((channel) => (channel + v - chroma) * 255);
}

/**
 * A class bound for a generated label: up to 12 significant digits, so a bound
 * computed in floating point reads `0.3`, not `0.30000000000000004`.
 */
function formatBound(value: number): string {
  return String(Number(value.toPrecision(12)));
}

/** Rounded so `0.75 * 96 / 72` is written as 1, not 0.9999999999999999. */
function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function isObject(value: unknown): value is CimObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown): CimObject | undefined {
  return isObject(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
