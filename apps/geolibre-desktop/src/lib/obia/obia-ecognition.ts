import {
  OBIA_CURVE_MAX_POINTS,
  classFieldSlug,
  type ObiaCondition,
  type ObiaDomain,
  type ObiaFuzzyClass,
  type ObiaIndexBands,
  type ObiaMembership,
  type ObiaProcess,
  type ObiaRuleOp,
  type ObiaRuleset,
} from "@geolibre/processing";

/**
 * A constrained importer for eCognition rule sets: the process tree of a
 * `.dcp` rule set or a `.dpr` project, converted to a workbench ruleset where
 * the workbench has an equivalent, with every part it leaves out reported.
 *
 * Converted: "execute child processes" (flattened, or a loop when it repeats),
 * "assign class", "remove classification" and "classification" by class
 * descriptions (membership functions and thresholds), on image object domains
 * with a class filter and "and" conditions. Features become workbench fields
 * where the workbench computes the same thing; any other feature keeps its
 * eCognition name, so a feature table exported from eCognition can supply it.
 * Segmentation is reported, not converted: the workbench's segmentation
 * algorithms differ, so it is redone under Segment.
 */

/** Why a process was not converted. */
export type EcognitionSkipReason =
  | "inactive"
  | "segmentation"
  | "output"
  | "algorithm"
  | "domain"
  | "condition"
  | "description"
  | "children";

/** A process the importer did not convert. */
export interface EcognitionSkipped {
  /** Position in the process tree, e.g. "1.2.3". */
  path: string;
  name: string;
  reason: EcognitionSkipReason;
  /** The algorithm, feature or construct involved. */
  detail?: string;
}

/** An eCognition feature the ruleset reads, and the workbench field for it. */
export interface EcognitionField {
  feature: string;
  field: string;
  /** False when the workbench does not compute it (the name is kept). */
  computed: boolean;
}

/** The result of importing a rule set. */
export interface EcognitionImport {
  /** The converted processes, or null when none converted. */
  ruleset: ObiaRuleset | null;
  /** Class names the converted processes use. */
  classes: string[];
  /** Image layer aliases, in the rule set's order. */
  layers: string[];
  /** Image layer alias to the 1-based band it was read from. */
  layerBands: Record<string, number>;
  fields: EcognitionField[];
  /** Image object level names the converted processes act on. */
  levels: string[];
  skipped: EcognitionSkipped[];
  /** Processes in the tree, and how many converted (a container counts when any child does). */
  processCount: number;
  converted: number;
}

/**
 * The largest file the importer reads: parsing runs in the page and holds
 * the file as text, so a much larger one would stall it (a 100 MB rule set
 * takes about 10 seconds).
 */
export const ECOGNITION_MAX_BYTES = 128 * 1024 * 1024;

/** Why a file could not be read as a rule set. */
export class EcognitionImportError extends Error {
  readonly code: "not-ruleset" | "encrypted" | "too-large" | "encoding";

  constructor(code: EcognitionImportError["code"], message: string) {
    super(message);
    this.name = "EcognitionImportError";
    this.code = code;
  }
}

const normGuid = (guid: string | null) => (guid ?? "").replace(/[{}]/g, "").toUpperCase();

/** eCognition algorithms by GUID: what the importer does with each. */
const ALGORITHMS: Record<string, { name: string; role?: "segmentation" | "output" }> = {
  "A8BA5775-CC39-4194-9A6A-A64872EE1F81": { name: "execute child processes" },
  "3AC44F21-C6B2-4804-9929-BB18BE6F2051": { name: "assign class" },
  "80BA6991-0BF5-4E95-BB7F-4F743CED8524": { name: "classification" },
  "5DB9115B-F192-4809-8175-CCF665B82CE7": { name: "remove classification" },
  "6534F2E1-485B-406F-B990-350824399FA8": {
    name: "multiresolution segmentation",
    role: "segmentation",
  },
  "0F96C846-956C-405F-AC42-81EBA4D1A755": { name: "chessboard segmentation", role: "segmentation" },
  "1AB8761A-C1D1-47A7-B608-A3A74C15DAAB": {
    name: "multi-threshold segmentation",
    role: "segmentation",
  },
  "EF18B6E8-2F63-11DD-ABB5-0019B95B8574": { name: "conditional quad tree", role: "segmentation" },
  "E8AAA2C4-4DCA-4684-A918-87E7C53CDC8D": { name: "export vector layer", role: "output" },
  "7B996F8D-0DDF-46CA-A55D-146C21D723BF": { name: "export accuracy assessment", role: "output" },
  "21D7783B-8DC4-4A95-83AD-7BBA897FBF0A": { name: "set custom view settings", role: "output" },
  "89896D3E-7B5F-4AEE-8588-CA10653B6C1C": { name: "define view layout", role: "output" },
  "C40685EB-D26E-402E-998B-56D40FDB5491": { name: "update results panel", role: "output" },
  "2328636B-BAD3-4F5D-B5AA-FC209A0BFB65": { name: "merge region" },
  "26A5FE32-0E27-4C1D-823D-3F2B3CA9712A": { name: "pixel-based object resizing" },
  "15EB83DD-5DE7-4F59-9CBD-60AA256ADFDE": { name: "update variable" },
  "FDD7E1EA-AD94-4865-A63E-4656BACBF4CA": { name: "update array" },
  "DC3261FA-551F-43FB-9BDA-90A9516E9054": { name: "compute statistical value" },
  "4D72CCF3-EB44-4DCB-B5E1-70CA007D50CE": { name: "delete image object level" },
  "422F931B-FB82-4853-A773-2A821FE23893": { name: "copy image object level" },
  "3C8CF763-5CC5-411A-B294-07D13BE20889": { name: "copy map" },
  "68B14002-A531-4066-8DB8-C7A68AF9E116": { name: "delete map" },
  "1CDFC452-7C27-418B-9D78-BED3B4204968": { name: "convert thematic objects to samples" },
  "7DAE5AF4-EC4E-4E94-A3CF-E325223EDB94": { name: "sample selection" },
  "01D48925-C5A5-435E-A657-54DC78F10D48": { name: "delete samples" },
  "D560144D-0A60-40B0-B69E-32E67AF10DD1": { name: "supervised classification" },
  "AAB04982-828B-4BDA-A573-AF19CDBEF1C0": { name: "unsupervised classification" },
  "A3BF9843-8B38-4677-9840-DEAA73F2B2F5": { name: "assign class by thematic layer" },
  "9777B530-2143-432B-8BFB-CD64CEF15A12": { name: "manual classification" },
  "7CE4098E-BB8E-4035-BF37-1AFECA6998F4": { name: "layer arithmetics" },
  "75BA92AD-A368-453A-A70F-D9048C6C1CC1": { name: "delete layer" },
  "4E4AA7FA-CEC7-4477-A7AE-9717D67DF912": { name: "if" },
  "6699F5EF-F161-4A24-9DC3-853E4402DF62": { name: "then" },
  "4045B141-C84D-41F7-B4E6-CD5E36186A8D": { name: "else" },
  "3E5F5000-025A-437C-BC5D-A099E975304A": {
    name: "spectral difference segmentation",
    role: "segmentation",
  },
  "C092C8B6-03A8-42C1-9C21-7A861FD0925C": { name: "quadtree segmentation", role: "segmentation" },
  "9EC47B47-C0C0-4961-BB9B-74B3B6DEEF0C": {
    name: "convert image objects to vector",
    role: "output",
  },
  "EACF742B-FABA-4AF2-82EE-43EB25BFE0CC": { name: "export project statistics", role: "output" },
  "3C74F8CF-367B-4D2C-ABE6-B0DD6B9EFD02": { name: "show user warning", role: "output" },
  "44001047-4A5B-42DF-BF1C-4C70A4F1A259": { name: "surface calculation" },
  "68A8CE3B-52AD-4E5F-B2FB-8001785778F3": { name: "rename image object level" },
  "991B8063-3ADB-4138-8327-23A2B948822F": { name: "string operation" },
};
const ALGORITHM_BY_GUID = new Map(
  Object.entries(ALGORITHMS).map(([guid, algorithm]) => [normGuid(guid), algorithm]),
);
const EXECUTE = "A8BA5775-CC39-4194-9A6A-A64872EE1F81";
const ASSIGN = "3AC44F21-C6B2-4804-9929-BB18BE6F2051";
const CLASSIFY = "80BA6991-0BF5-4E95-BB7F-4F743CED8524";
const UNASSIGN = "5DB9115B-F192-4809-8175-CCF665B82CE7";

/** Domains: image objects of a level, and "execute" (a container). */
const OBJECT_DOMAIN = "CED621BD-F4D1-4FFA-A2F6-DB2BB1913E8C";
const EXECUTE_DOMAIN = "CC9F2C30-4DB0-4EF2-B864-63560D1D6BF3";

/** eCognition comparison codes, as read from its process names. */
const COMPARE: Record<string, ObiaRuleOp> = {
  "1": "<=",
  "2": "<",
  "3": ">",
  "4": ">=",
  "5": "==",
  "6": "!=",
};

/** Parameter types that hold a plain number (anything else is a variable). */
const NUMERIC_TYPES = new Set(["double", "float", "int", "uint", "long", "ulong"]);

/** Loops that repeat "while something changes" run at most this often. */
const LOOP_WHILE_CHANGES = 1000;

/** Child elements with a tag name. */
const kids = (el: Element, tag?: string) =>
  Array.from(el.children).filter((child) => !tag || child.tagName === tag);
const kid = (el: Element | null | undefined, tag: string) =>
  el ? (kids(el, tag)[0] ?? null) : null;
/** Descendants with a tag name, in document order. */
const all = (el: Element, tag: string) => Array.from(el.getElementsByTagName(tag));
/** A `<DValue name="…">` parameter of a `<Params>` element. */
const param = (params: Element | null, name: string) =>
  params ? (kids(params, "DValue").find((dv) => dv.getAttribute("name") === name) ?? null) : null;

/**
 * The XML documents in a rule set or project file: a `.dcp` is one XML
 * document; a `.dpr` is binary with XML documents embedded.
 *
 * @param bytes The file's contents.
 */
export function ecognitionDocuments(bytes: Uint8Array): Document[] {
  // Decoded one character per byte to find the documents by offset; each is
  // then decoded from its bytes in the encoding it declares.
  const text = new TextDecoder("latin1").decode(bytes);
  const docs: Document[] = [];
  const matches = [...text.matchAll(/<\?xml[^>]*\?>\s*<([A-Za-z_][\w.-]*)/g)];
  matches.forEach((match, i) => {
    const start = match.index + match[0].length - match[1].length - 1;
    // A document ends at its root's last closing tag before the next one
    // starts (binary data may follow it), so a nested element with the
    // root's name does not cut it short.
    const limit = matches[i + 1]?.index ?? text.length;
    const close = `</${match[1]}>`;
    const end = text.lastIndexOf(close, limit - close.length);
    if (end < start) return;
    const declared = /encoding\s*=\s*["']([\w.-]+)["']/i.exec(match[0])?.[1] ?? "utf-8";
    // Never guess: an encoding the browser lacks, or bytes that are not
    // valid in it, would silently alter class and feature names.
    let xml: string;
    try {
      xml = new TextDecoder(declared, { fatal: true }).decode(
        bytes.subarray(start, end + close.length),
      );
    } catch {
      throw new EcognitionImportError(
        "encoding",
        `A document is not valid ${declared}, the encoding it declares.`,
      );
    }
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    if (!doc.getElementsByTagName("parsererror").length) docs.push(doc);
  });
  return docs;
}

/**
 * Parse a rule set or project file once, so it can be converted again with
 * other layer bands without re-reading it.
 *
 * @param bytes The file's contents (at most {@link ECOGNITION_MAX_BYTES}).
 * @throws EcognitionImportError for a file over the limit.
 */
export function parseEcognitionFile(bytes: Uint8Array): Document[] {
  if (bytes.byteLength > ECOGNITION_MAX_BYTES) {
    throw new EcognitionImportError("too-large", "The file is too large to read.");
  }
  return ecognitionDocuments(bytes);
}

/**
 * Convert an eCognition rule set (`.dcp`) or project (`.dpr`) to a workbench
 * ruleset, reporting what it leaves out.
 *
 * @param source The file's contents, or its documents from
 *   {@link parseEcognitionFile}.
 * @param layerBands Image layer alias to 1-based band; layers not given are
 *   read from the bands in the rule set's layer order.
 * @param indexBands The bands Measure computes NDVI and NDWI from; a
 *   customized index over the same bands becomes `ndvi` or `ndwi`.
 * @throws EcognitionImportError for a file over the size limit, or one that
 *   holds no process tree, or an encrypted one.
 */
export function importEcognitionRuleset(
  source: Uint8Array | Document[],
  layerBands: Readonly<Record<string, number>> = {},
  indexBands?: ObiaIndexBands,
): EcognitionImport {
  const docs = Array.isArray(source) ? source : parseEcognitionFile(source);
  const roots = docs.flatMap((doc) =>
    all(doc.documentElement, "ProcBase").filter((proc) =>
      ["ProcessList", "ProcList"].includes((proc.parentElement as Element | null)?.tagName ?? ""),
    ),
  );
  if (!roots.length) {
    const encrypted = docs.some((doc) => all(doc.documentElement, "EncryptedData").length);
    throw encrypted
      ? new EcognitionImportError("encrypted", "The rule set is encrypted.")
      : new EcognitionImportError("not-ruleset", "The file holds no eCognition process tree.");
  }

  // Classes by id, and their descriptions.
  const classById = new Map<string, string>();
  const descriptionOf = new Map<string, Element>();
  for (const doc of docs) {
    for (const cls of all(doc.documentElement, "Clss")) {
      const id = cls.getAttribute("id");
      const name = cls.getAttribute("name");
      if (id && name) classById.set(id, name);
    }
    for (const allTerm of all(doc.documentElement, "AllTerm")) {
      for (const term of kids(allTerm, "Term")) {
        const base = kids(term, "TermBase").at(-1);
        const id = base?.getAttribute("ClssId");
        if (id) descriptionOf.set(id, term);
      }
    }
  }

  // Image layers (in order) and thematic layers.
  const thematic = new Set<string>();
  for (const doc of docs) {
    for (const dv of all(doc.documentElement, "DValue")) {
      if (dv.getAttribute("type") === "thm_chnl") thematic.add(dv.getAttribute("value") ?? "");
    }
  }
  const layers: string[] = [];
  for (const doc of docs) {
    for (const proxy of all(doc.documentElement, "ChnlProxy")) {
      const name = proxy.getAttribute("strName");
      if (name && !thematic.has(name) && !layers.includes(name)) layers.push(name);
    }
  }
  const bands: Record<string, number> = {};
  layers.forEach((name, index) => {
    bands[name] = layerBands[name] ?? index + 1;
  });

  // Customized arithmetic features: name to expression over other features.
  const custom = new Map<string, { expr: string; inputs: string[] }>();
  for (const doc of docs) {
    for (const prop of all(doc.documentElement, "PropDscr")) {
      if (prop.getAttribute("group_id") !== "cust.object.prop") continue;
      const name = kid(prop, "PropDscrId")?.getAttribute("InstID");
      const params = kid(prop, "Params");
      const expr = param(params, "strExpr")?.getAttribute("value");
      const inputs = all(param(params, "valPropVctr") ?? prop, "PropDscrId").map(
        (id) => id.getAttribute("InstID") ?? "",
      );
      if (name && expr) custom.set(name, { expr, inputs });
    }
  }

  const fields = new Map<string, EcognitionField>();
  const bandOf = (alias: string) => (alias in bands ? bands[alias] : null);
  /** The workbench field for an eCognition feature (its own name if none). */
  const fieldFor = (feature: string, unit: string | null): string => {
    const key = `${feature}\u0000${unit ?? ""}`;
    const known = fields.get(key);
    if (known) return known.field;
    let field: string | null = null;
    const layerFeature = (prefix: string, out: string) => {
      if (!feature.startsWith(prefix)) return;
      const band = bandOf(feature.slice(prefix.length));
      if (band != null) field = `${out}${band}`;
    };
    layerFeature("Mean ", "mean_b");
    layerFeature("Standard deviation ", "std_b");
    layerFeature("Max. pixel value ", "max_b");
    layerFeature("Min. pixel value ", "min_b");
    if (feature === "Brightness") field = "brightness";
    // Areas and lengths in pixels (a base unit of 1); a membership function
    // does not say its unit, so only conditions map.
    if (feature === "Number of pixels" || (feature === "Area" && unit === "1")) field = "area_px";
    if (feature === "Border length" && unit === "1") field = "perimeter_px";
    const border = /^Rel\. border to (.+)$/.exec(feature);
    if (border) field = `nb_border_${classFieldSlug(border[1], new Set())}`;
    const parent = /^Existence of super objects (.+) \(1\)$/.exec(feature);
    if (parent) field = `parent_is_${classFieldSlug(parent[1], new Set())}`;
    const arithmetic = custom.get(feature);
    if (arithmetic) {
      const expr = arithmetic.expr.replace(/[\s;]/g, "");
      // A normalized difference of two layer means is the workbench's NDVI
      // or NDWI when its layers are read from the bands Measure uses for them.
      const [a, b] = arithmetic.inputs.map((input) =>
        input.startsWith("Mean ") ? bandOf(input.slice("Mean ".length)) : null,
      );
      if (expr === "(d00-d01)/(d00+d01)" && a != null && b != null && indexBands) {
        if (a === indexBands.nir && b === indexBands.red) field = "ndvi";
        else if (a === indexBands.green && b === indexBands.nir) field = "ndwi";
      }
    }
    const entry = { feature, field: field ?? feature, computed: field != null };
    fields.set(key, entry);
    return entry.field;
  };

  const skipped: EcognitionSkipped[] = [];
  const levels = new Set<string>();
  const usedClasses = new Set<string>();
  let processCount = 0;
  let converted = 0;

  /**
   * A threshold's value: in pixels for a base unit of 1 (areas, lengths),
   * else in the feature's unit; a file may hold only one of the two.
   */
  const thresholdValue = (el: Element) => {
    const order =
      el.getAttribute("eBaseUnit") === "1"
        ? ["ProcVrblValPxl", "ProcVrblValUnit"]
        : ["ProcVrblValUnit", "ProcVrblValPxl"];
    for (const tag of order) {
      const value = kid(kid(el, tag), "DValue");
      if (value) return value;
    }
    return null;
  };

  /** A condition, or the reason it cannot be one. */
  const condition = (
    eCmpr: string | null,
    feature: string | null | undefined,
    value: Element | null | undefined,
    unit: string | null,
  ): ObiaCondition | string => {
    const op = COMPARE[eCmpr ?? ""];
    const number = Number(value?.getAttribute("value"));
    if (!op) return `comparison ${eCmpr}`;
    if (!feature) return "a variable instead of a feature";
    if (!NUMERIC_TYPES.has(value?.getAttribute("type") ?? "") || !Number.isFinite(number))
      return `${feature} compared with a variable`;
    // "Existence of <class> (0)": whether a neighbor has the class, which is
    // a share of the border above 0.
    const exists = /^Existence of (.+) \(0\)$/.exec(feature);
    // (Unclassified neighbors are not counted that way.)
    if (
      exists &&
      exists[1] !== "unclassified" &&
      (op === "==" || op === "!=") &&
      (number === 0 || number === 1)
    ) {
      const field = `nb_border_${classFieldSlug(exists[1], new Set())}`;
      fields.set(`${feature}\u0000`, { feature, field, computed: true });
      return { field, op: (op === "==") === (number === 1) ? ">" : "<=", value: 0 };
    }
    return { field: fieldFor(feature, unit), op, value: number };
  };
  /** A version 7 `TermThrsh`, or a version 8+ `TermCondition`, as a condition. */
  const conditionOf = (el: Element) =>
    el.tagName === "TermThrsh"
      ? condition(
          el.getAttribute("eCmpr"),
          kid(el, "PropDscrId")?.getAttribute("InstID"),
          thresholdValue(el),
          el.getAttribute("eBaseUnit"),
        )
      : condition(
          el.getAttribute("eCmpr"),
          kid(kid(kid(el, "ProcVrblVal1"), "DValue"), "PropDscrId")?.getAttribute("InstID"),
          kid(kid(el, "ProcVrblVal2"), "DValue"),
          el.getAttribute("eBaseUnit"),
        );

  /** A process's domain, or the reason it cannot be one. */
  const domainOf = (proc: Element, container: boolean): ObiaDomain | string => {
    const domain = kid(proc, "Domain");
    if (!domain) return {};
    const guid = normGuid(domain.getAttribute("guid"));
    const params = kid(domain, "Params");
    if (!guid) {
      // Version 7 projects: a bare domain (a container's), or a level domain
      // with an unfiltered class filter.
      if (container && kids(domain).every((el) => el.tagName === "ProcDomain")) return {};
      const featureLevel = kid(domain, "ProcDmnFtrLvl");
      if (!featureLevel) return "not an image object level";
      const procDomain = kid(featureLevel, "ProcDomain");
      const level = kid(featureLevel, "MapLvlProxy")?.getAttribute("strName");
      if (level) levels.add(level);
      const result: ObiaDomain = {};
      // eState 2 filters by the listed classes (and unclassified with bUnclsfy).
      const filter = kid(procDomain, "mClssFltr");
      const state = filter?.getAttribute("eState") ?? "0";
      if (filter && state !== "0") {
        if (state !== "2") return `class filter state ${state}`;
        const classes: string[] = [];
        for (const item of all(filter, "int")) {
          const name = classById.get(item.getAttribute("value") ?? "");
          if (!name) return `unknown class ${item.getAttribute("value")}`;
          classes.push(name);
        }
        if (filter.getAttribute("bUnclsfy") === "1") classes.push("");
        result.classes = classes;
      }
      const thresholds = procDomain ? kids(procDomain, "TermThrsh") : [];
      const conditions: ObiaCondition[] = [];
      for (const threshold of thresholds) {
        const parsed = conditionOf(threshold);
        if (typeof parsed === "string") return parsed;
        conditions.push(parsed);
      }
      if (conditions.length) result.conditions = conditions;
      return result;
    }
    if (guid === EXECUTE_DOMAIN) return {};
    if (guid !== OBJECT_DOMAIN) return "not an image object level";
    if (param(params, "bSmplOnly")?.getAttribute("value") === "1") return "samples only";
    const level = kid(param(params, "valMapLvl"), "MapLvlProxy")?.getAttribute("strName");
    if (level) levels.add(level);
    const result: ObiaDomain = {};
    const filter = kids(kid(param(params, "mClssFltr"), "Values") ?? params ?? domain, "DValue");
    const classes: string[] = [];
    let any = false;
    for (const dv of filter) {
      const value = dv.getAttribute("value") ?? "";
      if (dv.getAttribute("type") === "clssId") {
        const name = classById.get(value);
        if (!name) return `unknown class ${value}`;
        classes.push(name);
      } else if (value === "Unclsfy") classes.push("");
      else if (value === "Disabled" || value === "All Classes") any = true;
    }
    if (!any && classes.length) result.classes = classes;
    const conditions: ObiaCondition[] = [];
    for (const name of ["valThrsh", "valThrsh2"]) {
      const holder = param(params, name);
      if (!holder || !kids(holder).length) continue;
      const threshold = kid(holder, "TermThrsh");
      const group = kid(threshold, "TermGroup");
      if (threshold && !group) {
        // Version 8: one condition per parameter, both combined by "and".
        if (!kid(threshold, "PropDscrId")) return "a condition format the importer does not read";
        const parsed = conditionOf(threshold);
        if (typeof parsed === "string") return parsed;
        conditions.push(parsed);
        continue;
      }
      // Never drop a condition: an unread format skips the process.
      if (!group) return "a condition format the importer does not read";
      if (kids(group, "TermGroup").length) return "nested condition groups";
      const conds = kids(group, "TermCondition");
      for (const [i, cond] of conds.entries()) {
        // Each condition's joint links it to the next: 0 is "and".
        if (i < conds.length - 1 && cond.getAttribute("eJoint") !== "0") return "an or condition";
        const parsed = conditionOf(cond);
        if (typeof parsed === "string") return parsed;
        conditions.push(parsed);
      }
    }
    if (conditions.length) result.conditions = conditions;
    return result;
  };

  /** A membership function from a class description clause. */
  const membership = (el: Element): ObiaMembership | string => {
    const feature = kid(el, "PropDscrId")?.getAttribute("InstID");
    if (!feature) return "a clause without a feature";
    if (el.tagName === "TermThrsh") {
      const op = COMPARE[el.getAttribute("eCmpr") ?? ""];
      const value = Number(thresholdValue(el)?.getAttribute("value"));
      if (!op || !Number.isFinite(value)) return `threshold on ${feature}`;
      return {
        field: fieldFor(feature, el.getAttribute("eBaseUnit")),
        type: "threshold",
        op,
        value,
      };
    }
    const hist = kid(el, "PropHist");
    const xs = hist ? kids(hist, "X").map((x) => Number(x.getAttribute("Val"))) : [];
    const ys = hist ? kids(hist, "Y").map((y) => Number(y.getAttribute("Val"))) : [];
    if (xs.length < 2 || ys.length !== xs.length + 2 || ![...xs, ...ys].every(Number.isFinite))
      return `membership function on ${feature}`;
    // Y holds the membership at each X (0..1 across the range), then the
    // range's ends in feature units.
    const [from, to] = ys.slice(xs.length);
    if (!(from < to)) return `membership function on ${feature}`;
    const points = ys.slice(0, xs.length);
    if (xs.some((x, i) => i > 0 && x < xs[i - 1])) return `membership function on ${feature}`;
    const even = xs.every((x, i) => Math.abs(x - i / (xs.length - 1)) < 1e-6);
    // Uneven points: resample evenly, holding the end values beyond them.
    const at = (t: number) => {
      if (t <= xs[0]) return points[0];
      if (t >= xs[xs.length - 1]) return points[points.length - 1];
      const j = xs.findIndex((x, i) => t >= x && t < xs[i + 1]);
      const span = xs[j + 1] - xs[j];
      return span ? points[j] + ((points[j + 1] - points[j]) * (t - xs[j])) / span : points[j + 1];
    };
    const values = even
      ? points
      : Array.from({ length: OBIA_CURVE_MAX_POINTS }, (_, i) =>
          at(i / (OBIA_CURVE_MAX_POINTS - 1)),
        );
    return {
      field: fieldFor(feature, null),
      type: "curve",
      from,
      to,
      values: values.map((v) => Math.min(1, Math.max(0, v))),
    };
  };

  /** A fuzzy class from a class description. */
  const fuzzyClass = (name: string, term: Element | undefined): ObiaFuzzyClass | string => {
    // No description at all is not the same as an empty one (membership 1):
    // it was stored somewhere the importer does not read.
    if (!term) return `no class description found for ${name}`;
    const evalType = term.getAttribute("TermEvalType") ?? "0";
    // 0 is and(min) and 1 or(max); others (products, means) are not mapped.
    const combine = evalType === "0" ? "and" : evalType === "1" ? "or" : null;
    if (!combine) return `operator ${evalType} in the description of ${name}`;
    const memberships: ObiaMembership[] = [];
    const visit = (el: Element): string | null => {
      for (const child of kids(el)) {
        if (child.tagName === "TermBase") continue;
        if (child.tagName === "TermNearNghb") return `nearest neighbor in ${name}`;
        if (child.tagName === "Term") {
          if ((child.getAttribute("TermEvalType") ?? "0") !== evalType)
            return `mixed operators in ${name}`;
          const err = visit(child);
          if (err) return err;
          continue;
        }
        if (child.tagName === "TermClause" || child.tagName === "TermThrsh") {
          const inner = kid(child, "TermThrsh") ?? child;
          const m = membership(inner);
          if (typeof m === "string") return m;
          memberships.push(m);
          continue;
        }
        return `${child.tagName} in ${name}`;
      }
      return null;
    };
    const err = visit(term);
    if (err) return err;
    return { className: name, combine, memberships };
  };

  const minMembership = (() => {
    for (const doc of docs) {
      const value = Number(all(doc.documentElement, "ClssHrchy")[0]?.getAttribute("MinProb"));
      if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
    }
    return 0.1;
  })();

  /** How often a process repeats: 1, a count, or until nothing changes. */
  const cycles = (proc: Element): number => {
    if (proc.getAttribute("bLoopChg") === "1") return LOOP_WHILE_CHANGES;
    const value = Number(
      kid(kid(proc, "vrblValMaxCycle"), "DValue")?.getAttribute("value") ??
        proc.getAttribute("iMaxCycle") ??
        "1",
    );
    return Number.isFinite(value) && value > 1
      ? Math.min(Math.round(value), LOOP_WHILE_CHANGES)
      : 1;
  };

  /** Convert a process and its children; skipped ones are reported. */
  const convert = (proc: Element, path: string): ObiaProcess[] => {
    processCount += 1;
    const name = proc.getAttribute("Name") ?? "";
    const children = kids(kid(proc, "SubProc") ?? proc, "ProcBase");
    const skip = (reason: EcognitionSkipReason, detail?: string): ObiaProcess[] => {
      skipped.push({ path, name, reason, ...(detail ? { detail } : {}) });
      // Its children are not run either.
      children.forEach((child, i) => countSkipped(child, `${path}.${i + 1}`));
      return [];
    };
    if (proc.getAttribute("bActive") === "0") return skip("inactive");
    const guid = normGuid(kid(proc, "Algorithm")?.getAttribute("guid") ?? null);
    const algorithm = ALGORITHM_BY_GUID.get(guid);
    if (!algorithm) return skip("algorithm", guid);
    if (algorithm.role === "segmentation") return skip("segmentation", algorithm.name);
    if (algorithm.role === "output") return skip("output", algorithm.name);
    if (![EXECUTE, ASSIGN, CLASSIFY, UNASSIGN].includes(guid))
      return skip("algorithm", algorithm.name);
    const domain = domainOf(proc, guid === EXECUTE);
    if (typeof domain === "string") return skip("domain", domain);
    const label = name ? { name } : {};
    const repeat = cycles(proc);
    const wrap = (processes: ObiaProcess[]): ObiaProcess[] =>
      repeat > 1 && processes.length
        ? [{ kind: "loop", ...label, processes, maxIterations: repeat }]
        : processes;

    if (guid === EXECUTE) {
      // A container: its own domain must not narrow what its children see.
      if (domain.classes || domain.conditions) return skip("domain", "a filtered parent");
      const inner = children.flatMap((child, i) => convert(child, `${path}.${i + 1}`));
      // The container converts to its children (or a loop around them),
      // when any of them converted.
      if (inner.length) converted += 1;
      return wrap(inner);
    }
    if (children.length) return skip("children");
    const scoped = domain.classes || domain.conditions ? { domain } : {};
    let process: ObiaProcess;
    const params = kid(kid(proc, "Algorithm"), "Params");
    if (guid === ASSIGN) {
      const id = param(params, "valClass")?.getAttribute("value") ?? "";
      const className = classById.get(id);
      // Class -1 is "unclassified".
      if (id === "-1") process = { kind: "unassign", ...label, ...scoped };
      else if (!className) return skip("algorithm", `assign class to unknown class ${id}`);
      else {
        usedClasses.add(className);
        process = { kind: "assign", ...label, ...scoped, className };
      }
    } else if (guid === UNASSIGN) {
      process = { kind: "unassign", ...label, ...scoped };
    } else {
      if (param(params, "bUseClssDscr")?.getAttribute("value") === "0")
        return skip("description", "classification without class descriptions");
      const ids = all(param(params, "lActvClss") ?? proc, "DValue")
        .filter((dv) => dv.getAttribute("type") === "clssId")
        .map((dv) => dv.getAttribute("value") ?? "");
      const classes: ObiaFuzzyClass[] = [];
      for (const id of ids) {
        const className = classById.get(id);
        if (!className) return skip("description", `unknown class ${id}`);
        const cls = fuzzyClass(className, descriptionOf.get(id));
        if (typeof cls === "string") return skip("description", cls);
        classes.push(cls);
      }
      if (!classes.length) return skip("description", "no active classes");
      classes.forEach((cls) => usedClasses.add(cls.className));
      process = { kind: "fuzzy", ...label, ...scoped, classes, minMembership };
    }
    converted += 1;
    return wrap([process]);
  };
  /** Count a process (and its children) that is not run. */
  const countSkipped = (proc: Element, path: string) => {
    processCount += 1;
    kids(kid(proc, "SubProc") ?? proc, "ProcBase").forEach((child, i) =>
      countSkipped(child, `${path}.${i + 1}`),
    );
  };

  const processes = roots.flatMap((root, i) => convert(root, String(i + 1)));
  return {
    ruleset: processes.length ? { processes } : null,
    classes: [...usedClasses],
    layers,
    layerBands: bands,
    fields: [...fields.values()],
    levels: [...levels],
    skipped,
    processCount,
    converted,
  };
}
