import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_BASEMAP,
  DEFAULT_LAYER_STYLE,
  createEmptyProject,
  formatPopupValue,
  isPopupClickEnabled,
  isPopupHoverEnabled,
  isSafePopupUrl,
  popupFieldLabel,
  resolveConfiguredPopupTitle,
  resolvePopupBody,
  resolvePopupRows,
  resolvePopupTitle,
  parseProject,
  projectFromStore,
  serializeProject,
  visiblePopupFields,
  visiblePopupProperties,
  type GeoLibreLayer,
  type LayerPopupConfig,
} from "@geolibre/core";

const CITY = {
  name: "St. Paul",
  sov_a3: "USA",
  pop_max: 734854,
  founded: "1854-11-01T00:00:00Z",
  site: "https://www.stpaul.gov/",
  created_by: "import",
  __geolibre_row: 12,
};

describe("popup enable flags", () => {
  it("shows the click popup unless the author turns it off", () => {
    assert.equal(isPopupClickEnabled(undefined), true);
    assert.equal(isPopupClickEnabled({}), true);
    assert.equal(isPopupClickEnabled({ click: true }), true);
    assert.equal(isPopupClickEnabled({ click: false }), false);
  });

  it("keeps the hover tooltip off unless the author turns it on", () => {
    assert.equal(isPopupHoverEnabled(undefined), false);
    assert.equal(isPopupHoverEnabled({}), false);
    assert.equal(isPopupHoverEnabled({ hover: true }), true);
  });
});

describe("visible popup fields", () => {
  it("drops GeoLibre's internal columns and the full-resolution photo twin", () => {
    const fields = visiblePopupFields({
      name: "a",
      __geolibre_row: 1,
      photo_full: "data:image/png;base64,AAA",
    });
    assert.deepEqual(fields, ["name"]);
  });

  it("drops fields the author hid or excluded", () => {
    const fields = visiblePopupFields(CITY, {
      created_by: "hidden",
      sov_a3: "excluded",
    });
    assert.deepEqual(fields, ["name", "pop_max", "founded", "site"]);
  });
});

describe("value formatting", () => {
  it("leaves an unconfigured value exactly as the popup always rendered it", () => {
    assert.equal(formatPopupValue(734854), "734854");
    assert.equal(formatPopupValue(null), "");
    assert.equal(formatPopupValue({ a: 1 }), '{"a":1}');
  });

  it("groups thousands and fixes decimals for a number field", () => {
    assert.equal(
      formatPopupValue(
        734854,
        { kind: "number", format: { thousands: true } },
        { locale: "en-US" },
      ),
      "734,854",
    );
    assert.equal(
      formatPopupValue(3.14159, { kind: "number", format: { decimals: 2 } }, { locale: "en-US" }),
      "3.14",
    );
  });

  it("falls back to the raw text when a number field holds something unparseable", () => {
    assert.equal(
      formatPopupValue("n/a", { kind: "number", format: { thousands: true } }, { locale: "en-US" }),
      "n/a",
    );
  });

  it("wraps a formatted value in the author's prefix and suffix", () => {
    assert.equal(
      formatPopupValue(
        1250,
        {
          kind: "number",
          format: { thousands: true, prefix: "$", suffix: " USD" },
        },
        { locale: "en-US" },
      ),
      "$1,250 USD",
    );
  });

  it("leaves an auto field's affixes unapplied, since auto is the untyped rendering", () => {
    // The designer offers Prefix/Suffix only for text/number/date for this
    // reason: an "auto" value may be sanitized KML markup or an inline
    // thumbnail, which a prefix cannot meaningfully wrap.
    assert.equal(formatPopupValue(12, { format: { prefix: "$", suffix: " USD" } }), "12");
    assert.equal(formatPopupValue(12, { kind: "auto", format: { prefix: "$" } }), "12");
    assert.equal(formatPopupValue(12, { kind: "text", format: { prefix: "$" } }), "$12");
  });

  it("treats a whitespace-only value as missing, not as zero", () => {
    // `Number(" ")` is 0 in JS, and a blank cell exported as a space is common
    // in CSV and GeoJSON, so this is the same "confident zero" the null guard
    // exists to prevent.
    assert.equal(formatPopupValue(" ", { kind: "number", format: { thousands: true } }), "");
    assert.equal(formatPopupValue("\t\n", { kind: "number" }), "");
    assert.equal(formatPopupValue(" ", { kind: "text", format: { prefix: "$" } }), "");
  });

  it("does not decorate an empty value with a lone prefix or unit", () => {
    assert.equal(formatPopupValue(null, { kind: "number", format: { suffix: " km" } }), "");
    assert.equal(formatPopupValue("", { kind: "text", format: { prefix: "$" } }), "");
  });

  it("formats dates, and reads a numeric value as epoch milliseconds", () => {
    assert.equal(
      formatPopupValue("1854-11-01T00:00:00Z", {
        kind: "date",
        format: { dateFormat: "iso" },
      }),
      "1854-11-01T00:00:00.000Z",
    );
    assert.equal(
      formatPopupValue("1854-11-01T00:00:00Z", {
        kind: "date",
        format: { dateFormat: "year" },
      }),
      "1854",
    );
    // Mid-year epoch on purpose: the year format reads local time, so a value
    // on a year boundary would assert differently per timezone.
    assert.equal(
      formatPopupValue(Date.UTC(1990, 5, 15), { kind: "date", format: { dateFormat: "year" } }),
      "1990",
    );
  });

  it("falls back to the raw text when a date field does not parse", () => {
    assert.equal(
      formatPopupValue("not a date", {
        kind: "date",
        format: { dateFormat: "iso" },
      }),
      "not a date",
    );
  });
});

describe("popup rows", () => {
  it("shows every visible property in data order when nothing is configured", () => {
    const rows = resolvePopupRows(CITY);
    assert.deepEqual(
      rows.map((row) => row.field),
      ["name", "sov_a3", "pop_max", "founded", "site", "created_by"],
    );
    assert.deepEqual(
      rows.map((row) => row.label),
      ["name", "sov_a3", "pop_max", "founded", "site", "created_by"],
    );
    assert.equal(
      rows.every((row) => row.kind === "auto"),
      true,
    );
  });

  it("applies the author's order, labels and formats", () => {
    const popup: LayerPopupConfig = {
      fields: [
        {
          field: "pop_max",
          label: "Population",
          kind: "number",
          format: { thousands: true },
        },
        { field: "name", label: "City" },
      ],
    };
    const rows = resolvePopupRows(CITY, { popup, locale: "en-US" });
    assert.deepEqual(
      rows.map((row) => [row.label, row.text]),
      [
        ["Population", "734,854"],
        ["City", "St. Paul"],
      ],
    );
  });

  it("never re-exposes a field the author hid, even when the popup names it", () => {
    const popup: LayerPopupConfig = {
      fields: [{ field: "created_by", label: "Imported by" }, { field: "name" }],
    };
    const rows = resolvePopupRows(CITY, {
      popup,
      fieldVisibility: { created_by: "hidden" },
    });
    assert.deepEqual(
      rows.map((row) => row.field),
      ["name"],
    );
  });

  it("skips a configured field the feature does not carry, and duplicates", () => {
    const popup: LayerPopupConfig = {
      fields: [
        { field: "name" },
        { field: "elevation" },
        { field: "name", label: "Again" },
        { field: "__geolibre_row" },
      ],
    };
    const rows = resolvePopupRows(CITY, { popup });
    assert.deepEqual(
      rows.map((row) => row.field),
      ["name"],
    );
  });

  it("returns only the flagged fields for a hover tooltip", () => {
    const popup: LayerPopupConfig = {
      fields: [
        { field: "name", label: "City", hover: true },
        { field: "sov_a3" },
        {
          field: "pop_max",
          kind: "number",
          format: { thousands: true },
          hover: true,
        },
      ],
    };
    const rows = resolvePopupRows(CITY, {
      popup,
      hover: true,
      locale: "en-US",
    });
    assert.deepEqual(
      rows.map((row) => [row.label, row.text]),
      [
        ["City", "St. Paul"],
        ["pop_max", "734,854"],
      ],
    );
  });

  it("shows nothing on hover when the author flagged no field", () => {
    assert.deepEqual(resolvePopupRows(CITY, { hover: true }), []);
    assert.deepEqual(
      resolvePopupRows(CITY, {
        popup: { fields: [{ field: "name" }] },
        hover: true,
      }),
      [],
    );
  });

  it("keeps image rows out of the hover tooltip", () => {
    const popup: LayerPopupConfig = {
      fields: [
        { field: "thumb", kind: "image", hover: true },
        { field: "logo", hover: true },
        { field: "name", hover: true },
      ],
    };
    const properties = {
      ...CITY,
      thumb: "https://example.com/a.png",
      // An unconfigured value that the "auto" renderer would draw as a
      // thumbnail: its text form is the whole data URL.
      logo: "data:image/png;base64,AAAA",
    };
    const rows = resolvePopupRows(properties, { popup, hover: true });
    assert.deepEqual(
      rows.map((row) => row.field),
      ["name"],
    );
  });

  it("still shows image rows in the click popup", () => {
    const popup: LayerPopupConfig = {
      fields: [{ field: "thumb", kind: "image", hover: true }],
    };
    const rows = resolvePopupRows({ ...CITY, thumb: "https://example.com/a.png" }, { popup });
    assert.deepEqual(
      rows.map((row) => [row.field, row.kind]),
      [["thumb", "image"]],
    );
  });

  it("carries the author's link text through to the row", () => {
    const rows = resolvePopupRows(CITY, {
      popup: {
        fields: [
          {
            field: "site",
            kind: "link",
            format: { linkLabel: "City website" },
          },
        ],
      },
    });
    assert.equal(rows[0].kind, "link");
    assert.equal(rows[0].linkLabel, "City website");
    assert.equal(rows[0].value, "https://www.stpaul.gov/");
  });
});

describe("popup title", () => {
  it("falls back to the layer name with no configuration", () => {
    assert.equal(resolvePopupTitle("us_cities", CITY, undefined), "us_cities");
  });

  it("leads with the title field's value", () => {
    assert.equal(resolvePopupTitle("us_cities", CITY, { titleField: "name" }), "St. Paul");
  });

  it("prefers the title expression over the title field", () => {
    assert.equal(
      resolvePopupTitle("us_cities", CITY, {
        titleField: "sov_a3",
        titleExpression: '["concat", ["get", "name"], ", ", ["get", "sov_a3"]]',
      }),
      "St. Paul, USA",
    );
  });

  it("falls back to the layer name when the title expression is broken", () => {
    assert.equal(
      resolvePopupTitle("us_cities", CITY, { titleExpression: '["nope", 1]' }),
      "us_cities",
    );
  });

  it("falls back to the layer name when the title field is empty or hidden", () => {
    assert.equal(resolvePopupTitle("us_cities", CITY, { titleField: "missing" }), "us_cities");
    assert.equal(
      resolvePopupTitle(
        "us_cities",
        CITY,
        { titleField: "name" },
        { fieldVisibility: { name: "hidden" } },
      ),
      "us_cities",
    );
  });
});

describe("configured popup title", () => {
  // The hover tooltip suppresses itself when there is nothing to say, and that
  // decision has to rest on whether a title was configured — not on whether the
  // resolved text happens to match the layer name.
  it("reports null when no title is configured", () => {
    assert.equal(resolveConfiguredPopupTitle(CITY, undefined), null);
    assert.equal(resolveConfiguredPopupTitle(CITY, { fields: [{ field: "name" }] }), null);
  });

  it("reports a configured title that equals the layer's own name", () => {
    const properties = { ...CITY, name: "us_cities" };
    assert.equal(resolveConfiguredPopupTitle(properties, { titleField: "name" }), "us_cities");
    // The layer-name fallback would return the same string, so only the
    // null-vs-value distinction tells a real title from no title at all.
    assert.equal(resolvePopupTitle("us_cities", properties, { titleField: "name" }), "us_cities");
  });

  it("reports null when the configured title produces nothing", () => {
    assert.equal(resolveConfiguredPopupTitle(CITY, { titleField: "missing" }), null);
    assert.equal(resolveConfiguredPopupTitle(CITY, { titleExpression: '["nope", 1]' }), null);
    assert.equal(
      resolveConfiguredPopupTitle(
        CITY,
        { titleField: "name" },
        { fieldVisibility: { name: "hidden" } },
      ),
      null,
    );
  });
});

describe("popup body expression", () => {
  it("returns null when there is no expression, so the field rows render", () => {
    assert.equal(resolvePopupBody(CITY, undefined), null);
    assert.equal(resolvePopupBody(CITY, { fields: [{ field: "name" }] }), null);
  });

  it("renders a sentence from the feature's properties", () => {
    assert.equal(
      resolvePopupBody(CITY, {
        bodyExpression: '["concat", ["get", "name"], " is in ", ["get", "sov_a3"], "."]',
      }),
      "St. Paul is in USA.",
    );
  });

  it("returns null for a broken expression rather than printing the error", () => {
    assert.equal(resolvePopupBody(CITY, { bodyExpression: '["get"]' }), null);
  });
});

describe("expressions honor field visibility", () => {
  // The module's stated invariant is that a hidden or excluded field never
  // reaches a popup. An expression has no field list to filter, so its input
  // has to be filtered instead — otherwise `["get", "ssn"]` in a title or body
  // walks straight past fieldVisibility, and does it on hover with no click.
  const SENSITIVE = { name: "St. Paul", ssn: "123-45-6789", __geolibre_row: 3 };

  it("hides a hidden field from a body expression", () => {
    assert.equal(
      resolvePopupBody(
        SENSITIVE,
        { bodyExpression: '["to-string", ["get", "ssn"]]' },
        {
          fieldVisibility: { ssn: "hidden" },
        },
      ),
      null,
    );
  });

  it("hides an excluded field from a title expression", () => {
    assert.equal(
      resolveConfiguredPopupTitle(
        SENSITIVE,
        { titleExpression: '["get", "ssn"]' },
        {
          fieldVisibility: { ssn: "excluded" },
        },
      ),
      null,
    );
  });

  it("hides GeoLibre's internal columns from an expression", () => {
    assert.equal(
      resolveConfiguredPopupTitle(SENSITIVE, {
        titleExpression: '["to-string", ["get", "__geolibre_row"]]',
      }),
      null,
    );
  });

  it("still reads a visible field", () => {
    assert.equal(
      resolveConfiguredPopupTitle(
        SENSITIVE,
        { titleExpression: '["get", "name"]' },
        {
          fieldVisibility: { ssn: "hidden" },
        },
      ),
      "St. Paul",
    );
  });

  it("filters the property record the expressions are handed", () => {
    assert.deepEqual(visiblePopupProperties(SENSITIVE, { ssn: "hidden" }), {
      name: "St. Paul",
    });
  });
});

describe("untrusted configuration", () => {
  // A popup block reaches the renderer from a hand-edited `.geolibre.json`, an
  // imported layer-library bundle, or an MCP-authored project, so a key typed
  // as `string` may hold anything. None of it may throw.
  const junk = {
    titleField: 42,
    titleExpression: { nope: true },
    bodyExpression: 7,
    fields: "not an array",
  } as unknown as LayerPopupConfig;

  it("falls back to the layer name for a non-string title", () => {
    assert.equal(resolvePopupTitle("us_cities", CITY, junk), "us_cities");
  });

  it("renders no body for a non-string body expression", () => {
    assert.equal(resolvePopupBody(CITY, junk), null);
  });

  it("treats a non-array field list as no configuration at all", () => {
    const rows = resolvePopupRows(CITY, { popup: junk });
    assert.deepEqual(
      rows.map((row) => row.field),
      ["name", "sov_a3", "pop_max", "founded", "site", "created_by"],
    );
  });

  it("drops field entries whose name is not a string", () => {
    const popup = {
      fields: [null, { field: 3 }, { field: "name", label: 9 }],
    } as unknown as LayerPopupConfig;
    const rows = resolvePopupRows(CITY, { popup });
    assert.deepEqual(
      rows.map((row) => [row.field, row.label]),
      [["name", "name"]],
    );
  });
});

describe("expression caching", () => {
  // The hover tooltip resolves the title once per animation frame, so the same
  // source string must not be recompiled every time — but a cached compile must
  // still evaluate against whatever feature it is handed.
  it("evaluates a repeated title expression against each feature", () => {
    const popup: LayerPopupConfig = { titleExpression: '["get", "name"]' };
    assert.equal(resolvePopupTitle("layer", CITY, popup), "St. Paul");
    assert.equal(resolvePopupTitle("layer", { ...CITY, name: "Olympia" }, popup), "Olympia");
    assert.equal(resolvePopupTitle("layer", CITY, popup), "St. Paul");
  });

  it("honors the zoom it is given for a zoom-dependent expression", () => {
    const popup: LayerPopupConfig = { titleExpression: '["to-string", ["zoom"]]' };
    assert.equal(resolvePopupTitle("layer", CITY, popup, { zoom: 4 }), "4");
    assert.equal(resolvePopupTitle("layer", CITY, popup, { zoom: 9 }), "9");
    assert.equal(resolvePopupTitle("layer", CITY, popup, { zoom: 4 }), "4");
  });
});

describe("popup URL safety", () => {
  it("accepts http(s) links and refuses everything else", () => {
    assert.equal(isSafePopupUrl("https://example.com/a"), true);
    assert.equal(isSafePopupUrl("http://example.com/a"), true);
    assert.equal(isSafePopupUrl("javascript:alert(1)"), false);
    assert.equal(isSafePopupUrl("data:text/html,<script>"), false);
    assert.equal(isSafePopupUrl(42), false);
  });

  it("accepts an inline raster data URL only for an image, never SVG", () => {
    assert.equal(isSafePopupUrl("data:image/png;base64,AAA", true), true);
    assert.equal(isSafePopupUrl("data:image/png;base64,AAA"), false);
    assert.equal(isSafePopupUrl("data:image/svg+xml;base64,AAA", true), false);
  });
});

describe("field labels", () => {
  it("uses the raw field name when the label is blank", () => {
    assert.equal(popupFieldLabel({ field: "pop_max" }), "pop_max");
    assert.equal(popupFieldLabel({ field: "pop_max", label: "   " }), "pop_max");
    assert.equal(popupFieldLabel({ field: "pop_max", label: "Population" }), "Population");
  });
});

describe("project round trip", () => {
  it("persists the popup design through save and reload", () => {
    const popup: LayerPopupConfig = {
      hover: true,
      titleField: "name",
      showFeatureId: false,
      fields: [
        {
          field: "pop_max",
          label: "Population",
          kind: "number",
          format: { thousands: true },
          hover: true,
        },
        { field: "region" },
      ],
    };
    const layer: GeoLibreLayer = {
      id: "cities",
      name: "us_cities",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
      geojson: { type: "FeatureCollection", features: [] },
      popup,
    };
    const project = projectFromStore({
      projectName: "Popups",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [layer],
      preferences: createEmptyProject().preferences,
      metadata: {},
    });
    assert.deepEqual(project.layers[0]?.popup, popup);
    const reparsed = parseProject(serializeProject(project));
    assert.deepEqual(reparsed.layers[0]?.popup, popup);
  });
});
