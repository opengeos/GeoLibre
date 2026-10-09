import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOMParser } from "linkedom";
import { runRuleset, validateRuleset, type ObiaFeatureTable } from "@geolibre/processing";

Object.assign(globalThis, { DOMParser });
const { importEcognitionRuleset, EcognitionImportError, ECOGNITION_MAX_BYTES } =
  await import("../apps/geolibre-desktop/src/lib/obia/obia-ecognition");

const EXECUTE = "A8BA5775-CC39-4194-9A6A-A64872EE1F81";
const ASSIGN = "3AC44F21-C6B2-4804-9929-BB18BE6F2051";
const CLASSIFY = "80BA6991-0BF5-4e95-BB7F-4F743CED8524";
const UNASSIGN = "5DB9115B-F192-4809-8175-CCF665B82CE7";
const MRS = "6534F2E1-485B-406f-B990-350824399FA8";
const MERGE = "2328636B-BAD3-4f5d-B5AA-FC209A0BFB65";
const OBJECTS = "CED621BD-F4D1-4ffa-A2F6-DB2BB1913E8C";
const EXEC_DOMAIN = "CC9F2C30-4DB0-4ef2-B864-63560D1D6BF3";

const feature = (name: string) =>
  `<DValue type="propDscrId"><PropDscrId InstID="${name}"/></DValue>`;
/** An `eCmpr` condition; `last` ends the "and" chain. */
const cond = (name: string, cmp: number, value: number, last = true, unit = 0) =>
  `<TermCondition eCmpr="${cmp}" eBaseUnit="${unit}" eJoint="${last ? 2 : 0}"><ProcVrblVal1>${feature(name)}</ProcVrblVal1><ProcVrblVal2><DValue value="${value}" type="double"/></ProcVrblVal2></TermCondition>`;
/** An image object domain with a class filter and conditions. */
const objects = (filter: string[], conditions = "") =>
  `<Domain guid="${OBJECTS}"><Params><DValue type="lvlName" name="valMapLvl"><MapLvlProxy strName="Level 1"/></DValue><DValue type="vector" name="mClssFltr"><Values>${filter
    .map((f) =>
      /^\d+$/.test(f)
        ? `<DValue value="${f}" type="clssId"/>`
        : `<DValue value="${f}" type="string"/>`,
    )
    .join(
      "",
    )}</Values></DValue><DValue type="threshold" name="valThrsh"><TermThrsh><TermGroup eJoint="2">${conditions}</TermGroup></TermThrsh></DValue></Params></Domain>`;
const proc = (
  name: string,
  guid: string,
  params: string,
  domain: string,
  children = "",
  attrs = "",
) =>
  `<ProcBase Name="${name}" bActive="1" ${attrs}><Algorithm guid="${guid}"><Params>${params}</Params></Algorithm>${domain}<SubProc>${children}</SubProc></ProcBase>`;
const execDomain = `<Domain guid="${EXEC_DOMAIN}"><Params/></Domain>`;

/** A rule set exercising each converted construct and some skipped ones. */
const RULESET = `<?xml version="1.0" encoding="UTF-8"?>
<eCog.Proc>
  <ObjectDependencies>
    <ImgLayers><ChnlProxyCntnr><Layers>
      <ChnlProxy strName="Red"/><ChnlProxy strName="Green"/><ChnlProxy strName="NIR"/>
    </Layers></ChnlProxyCntnr></ImgLayers>
    <ClssHrchy MinProb="0.2">
      <AllClss>
        <Clss id="1" name="Water"/><Clss id="2" name="Forest"/><Clss id="3" name="Grass"/>
      </AllClss>
      <AllTerm>
        <Term TermEvalType="0">
          <TermClause><TermBase ClssId="2"/><PropDscrId InstID="Mean NIR"/><PropHist>
            <X Val="0"/><X Val="0.5"/><X Val="1"/>
            <Y Val="0"/><Y Val="0.5"/><Y Val="1"/><Y Val="50"/><Y Val="150"/>
          </PropHist></TermClause>
          <TermBase ClssId="2"/>
        </Term>
        <Term TermEvalType="0"><TermBase ClssId="3"/></Term>
      </AllTerm>
    </ClssHrchy>
    <PropDscr group_id="cust.object.prop"><PropDscrId InstID="NDVI"/><Params>
      <DValue name="valPropVctr" type="vector"><Values>
        <DValue type="propDscrId"><PropDscrId InstID="Mean NIR"/></DValue>
        <DValue type="propDscrId"><PropDscrId InstID="Mean Red"/></DValue>
      </Values></DValue>
      <DValue value="(d00;-d01;)/(d00;+d01;)" type="string" name="strExpr"/>
    </Params></PropDscr>
  </ObjectDependencies>
  <ProcessList>
    ${proc(
      "main",
      EXECUTE,
      "",
      execDomain,
      [
        proc("segment", MRS, "", ""),
        proc(
          "water",
          ASSIGN,
          `<DValue value="1" type="clssId" name="valClass"/>`,
          objects(["Unclsfy", "User defined"], cond("NDVI", 1, 0.05)),
        ),
        proc(
          "vegetation",
          CLASSIFY,
          `<DValue name="lActvClss" type="vector"><Values><DValue value="2" type="clssId"/><DValue value="3" type="clssId"/></Values></DValue><DValue value="1" type="bool" name="bUseClssDscr"/>`,
          objects(["Unclsfy"], cond("Area", 3, 4, true, 1)),
        ),
        proc(
          "grow water",
          EXECUTE,
          "",
          execDomain,
          proc(
            "edge",
            ASSIGN,
            `<DValue value="1" type="clssId" name="valClass"/>`,
            objects(["3"], cond("Existence of Water (0)", 5, 1, false) + cond("Mean Green", 2, 60)),
          ),
          `bLoopChg="1"`,
        ),
        proc("tidy", UNASSIGN, "", objects(["2"], cond("Brightness", 2, 10))),
        proc("merge", MERGE, "", objects(["1"])),
        proc("disabled", ASSIGN, "", objects(["Disabled"])).replace('bActive="1"', 'bActive="0"'),
        proc(
          "odd",
          ASSIGN,
          `<DValue value="1" type="clssId" name="valClass"/>`,
          objects(["Disabled"], cond("Mean Slope", 4, 3)),
        ),
      ].join(""),
    )}
  </ProcessList>
</eCog.Proc>`;

const bytes = (text: string) => new TextEncoder().encode(text);

describe("eCognition rule set import", () => {
  it("converts the supported processes and reports the rest", () => {
    const result = importEcognitionRuleset(bytes(RULESET), {}, { red: 1, nir: 3 });
    assert.deepEqual(result.layers, ["Red", "Green", "NIR"]);
    assert.deepEqual(result.levels, ["Level 1"]);
    assert.equal(result.processCount, 10);
    assert.equal(result.converted, 7);
    assert.deepEqual(
      result.skipped.map((s) => [s.path, s.reason]),
      [
        ["1.1", "segmentation"],
        ["1.6", "algorithm"],
        ["1.7", "inactive"],
      ],
    );
    assert.deepEqual(result.ruleset, {
      processes: [
        {
          kind: "assign",
          name: "water",
          domain: { classes: [""], conditions: [{ field: "ndvi", op: "<=", value: 0.05 }] },
          className: "Water",
        },
        {
          kind: "fuzzy",
          name: "vegetation",
          domain: { classes: [""], conditions: [{ field: "area_px", op: ">", value: 4 }] },
          classes: [
            {
              className: "Forest",
              combine: "and",
              memberships: [
                { field: "mean_b3", type: "curve", from: 50, to: 150, values: [0, 0.5, 1] },
              ],
            },
            // No description: membership 1.
            { className: "Grass", combine: "and", memberships: [] },
          ],
          minMembership: 0.2,
        },
        {
          kind: "loop",
          name: "grow water",
          maxIterations: 1000,
          processes: [
            {
              kind: "assign",
              name: "edge",
              domain: {
                classes: ["Grass"],
                conditions: [
                  { field: "nb_border_water", op: ">", value: 0 },
                  { field: "mean_b2", op: "<", value: 60 },
                ],
              },
              className: "Water",
            },
          ],
        },
        {
          kind: "unassign",
          name: "tidy",
          domain: {
            classes: ["Forest"],
            conditions: [{ field: "brightness", op: "<", value: 10 }],
          },
        },
        {
          kind: "assign",
          name: "odd",
          domain: { conditions: [{ field: "Mean Slope", op: ">=", value: 3 }] },
          className: "Water",
        },
      ],
    });
    // A feature the workbench does not compute keeps its name.
    assert.deepEqual(
      result.fields.filter((f) => !f.computed).map((f) => f.feature),
      ["Mean Slope"],
    );
  });

  it("runs the converted ruleset on measured features", () => {
    const { ruleset } = importEcognitionRuleset(bytes(RULESET), {}, { red: 1, nir: 3 });
    assert.ok(ruleset);
    const fields = ["ndvi", "area_px", "mean_b2", "mean_b3", "brightness", "Mean Slope"];
    assert.ok("ruleset" in validateRuleset(ruleset, fields, ["Water", "Forest", "Grass"]));
    // Object 1 is water by NDVI; 2 forest; 3 grass next to water with low
    // green, so the loop turns it to water; 4 grass far away.
    const table: ObiaFeatureTable = {
      fields,
      rows: new Map([
        [1, { ndvi: 0, area_px: 10, mean_b2: 50, mean_b3: 20, brightness: 30, "Mean Slope": 0 }],
        [2, { ndvi: 0.6, area_px: 10, mean_b2: 80, mean_b3: 150, brightness: 30, "Mean Slope": 0 }],
        [3, { ndvi: 0.3, area_px: 10, mean_b2: 50, mean_b3: 60, brightness: 30, "Mean Slope": 0 }],
        [4, { ndvi: 0.3, area_px: 10, mean_b2: 50, mean_b3: 60, brightness: 30, "Mean Slope": 0 }],
      ]),
    };
    const adjacency = new Map([
      [1, new Map([[3, 1]])],
      [2, new Map([[4, 1]])],
      [3, new Map([[1, 1]])],
      [4, new Map([[2, 1]])],
    ]);
    const { predictions } = runRuleset(table, adjacency, ["Water", "Forest", "Grass"], ruleset);
    assert.deepEqual([...predictions].sort(), [
      [1, "Water"],
      [2, "Forest"],
      [3, "Water"],
      [4, "Grass"],
    ]);
  });

  it("reads layers by the bands given, and processes from a binary project", () => {
    const project = new Uint8Array([
      ...[0, 1, 2, 255],
      ...bytes(
        RULESET.replace("<ProcessList>", "<ProcList>").replace("</ProcessList>", "</ProcList>"),
      ),
      ...[7, 0, 62, 9],
    ]);
    const result = importEcognitionRuleset(project, { NIR: 4, Green: 1 });
    assert.deepEqual(result.layerBands, { Red: 1, Green: 1, NIR: 4 });
    assert.equal(result.converted, 7);
    assert.ok(result.fields.some((f) => f.field === "mean_b4"));
    // NIR is now read from band 4, which Measure does not use for NDVI here.
    assert.ok(result.fields.some((f) => f.feature === "NDVI" && !f.computed));
  });

  it("reads version 8 conditions and never drops one it cannot read", () => {
    // Version 8: one TermThrsh per valThrsh/valThrsh2 parameter, pixel
    // values in ProcVrblValPxl.
    const v8 = (threshold: string, threshold2: string) =>
      `<Domain guid="${OBJECTS}"><Params><DValue type="vector" name="mClssFltr"><Values><DValue value="Unclsfy" type="string"/></Values></DValue><DValue type="threshold" name="valThrsh">${threshold}</DValue><DValue type="threshold" name="valThrsh2">${threshold2}</DValue></Params></Domain>`;
    const term = (name: string, cmp: number, unitTag: string, value: number, unit = 0) =>
      `<TermThrsh eCmpr="${cmp}" eBaseUnit="${unit}"><PropDscrId InstID="${name}"/><${unitTag}><DValue value="${value}" type="double"/></${unitTag}></TermThrsh>`;
    const text = (domain: string) =>
      `<?xml version="1.0"?><eCog.Proc><ObjectDependencies><ImgLayers><Layers><ChnlProxy strName="G"/></Layers></ImgLayers><ClssHrchy><AllClss><Clss id="1" name="Garbage"/></AllClss></ClssHrchy></ObjectDependencies><ProcessList>${proc(
        "p",
        ASSIGN,
        `<DValue value="1" type="clssId" name="valClass"/>`,
        domain,
      )}</ProcessList></eCog.Proc>`;
    const both = importEcognitionRuleset(
      bytes(
        text(v8(term("Mean G", 5, "ProcVrblValUnit", 0), term("Area", 2, "ProcVrblValPxl", 5, 1))),
      ),
    );
    assert.deepEqual(both.ruleset?.processes[0], {
      kind: "assign",
      name: "p",
      domain: {
        classes: [""],
        conditions: [
          { field: "mean_b1", op: "==", value: 0 },
          { field: "area_px", op: "<", value: 5 },
        ],
      },
      className: "Garbage",
    });
    const unread = importEcognitionRuleset(bytes(text(v8("<Something/>", ""))));
    assert.equal(unread.ruleset, null);
    assert.equal(unread.skipped[0].reason, "domain");
  });

  it("resamples uneven membership points, holding the end values", () => {
    const hist = (xs: number[], ys: number[]) =>
      `<PropHist>${xs.map((x) => `<X Val="${x}"/>`).join("")}${ys.map((y) => `<Y Val="${y}"/>`).join("")}</PropHist>`;
    const text = (h: string) =>
      `<?xml version="1.0"?><eCog.Proc><ObjectDependencies><ClssHrchy><AllClss><Clss id="1" name="A"/></AllClss><AllTerm><Term TermEvalType="0"><TermClause><PropDscrId InstID="Brightness"/>${h}</TermClause><TermBase ClssId="1"/></Term></AllTerm></ClssHrchy></ObjectDependencies><ProcessList>${proc(
        "c",
        CLASSIFY,
        `<DValue name="lActvClss" type="vector"><Values><DValue value="1" type="clssId"/></Values></DValue>`,
        "",
      )}</ProcessList></eCog.Proc>`;
    // Points stop at 0.5: the curve holds 1 from there to the end.
    const result = importEcognitionRuleset(bytes(text(hist([0, 0.25, 0.5], [0, 1, 1, 0, 100]))));
    const process = result.ruleset?.processes[0];
    assert.equal(process?.kind, "fuzzy");
    const membership = process?.kind === "fuzzy" ? process.classes[0].memberships[0] : null;
    assert.ok(membership?.type === "curve");
    assert.equal(membership.values.length, 64);
    assert.ok(Math.abs(membership.values[8] - 0.5079) < 1e-3);
    assert.ok(membership.values.slice(16).every((v) => v === 1));
    // A class with no description stored is skipped, not taken as empty.
    const missing = importEcognitionRuleset(
      bytes(text(hist([0, 1], [0, 1, 0, 1])).replace(/<AllTerm>[\s\S]*<\/AllTerm>/, "")),
    );
    assert.equal(missing.ruleset, null);
    assert.match(missing.skipped[0].detail ?? "", /no class description/);
    // Points out of order are not read.
    const unordered = importEcognitionRuleset(bytes(text(hist([0, 0.5, 0.25], [0, 1, 1, 0, 100]))));
    assert.equal(unordered.skipped[0].reason, "description");
  });

  it("refuses a file over the size limit", () => {
    assert.throws(
      () => importEcognitionRuleset(new Uint8Array(ECOGNITION_MAX_BYTES + 1)),
      (err: unknown) => err instanceof EcognitionImportError && err.code === "too-large",
    );
  });

  it("reads names in the encoding the document declares", () => {
    const text = `<?xml version="1.0" encoding="UTF-8"?><eCog.Proc><ObjectDependencies><ClssHrchy><AllClss><Clss id="1" name="Forêt"/></AllClss></ClssHrchy></ObjectDependencies><ProcessList>${proc(
      "p",
      ASSIGN,
      `<DValue value="1" type="clssId" name="valClass"/>`,
      "",
    )}</ProcessList></eCog.Proc>`;
    // In a binary project, after some bytes that are not UTF-8.
    const project = new Uint8Array([0xff, 0xfe, 0x80, ...bytes(text), 0xc3]);
    assert.deepEqual(importEcognitionRuleset(project).classes, ["Forêt"]);
  });

  it("rejects a file without a process tree", () => {
    assert.throws(
      () => importEcognitionRuleset(bytes("<?xml version='1.0'?><Other/>")),
      (err: unknown) => err instanceof EcognitionImportError && err.code === "not-ruleset",
    );
  });
});
