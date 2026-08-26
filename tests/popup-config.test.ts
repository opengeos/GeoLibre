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
  resolvePopupBody,
  resolvePopupRows,
  resolvePopupTitle,
  parseProject,
  projectFromStore,
  serializeProject,
  visiblePopupFields,
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
    assert.equal(formatPopupValue(0, { kind: "date", format: { dateFormat: "year" } }), "1970");
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
      type: "vector",
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
