import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  DEFAULT_PROJECT_PREFERENCES,
  createProjectTemplate,
  detachProjectCopy,
  parseProject,
  serializeProject,
  useAppStore,
  type GeoLibreLayer,
  type GeoLibreProject,
  type ProjectTemplateEntry,
} from "@geolibre/core";

function sampleProject(patch: Partial<GeoLibreProject> = {}): GeoLibreProject {
  const layerA: GeoLibreLayer = {
    id: "layer-env-1",
    name: "River Water Quality",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 0.8,
    style: { ...DEFAULT_LAYER_STYLE, fillColor: "#0088cc" },
    metadata: { provider: "Environmental Agency" },
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { station: "Alpha", ph: 7.2 },
          geometry: { type: "Point", coordinates: [12.49, 41.9] },
        },
      ],
    },
  };

  return {
    id: "proj-orig-12345",
    version: "2.4.0",
    name: "Regional Watershed Analysis",
    mapView: { center: [12.49, 41.9], zoom: 11.5, bearing: 15, pitch: 30 },
    basemapStyleUrl: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    basemapVisible: true,
    basemapOpacity: 1,
    layers: [layerA],
    layerGroups: [
      { id: "grp-1", name: "Water Resources", collapsed: false, visible: true, opacity: 1 },
    ],
    styles: {
      customStyle1: { ...DEFAULT_LAYER_STYLE, fillColor: "#ffaa00" },
    },
    preferences: { ...DEFAULT_PROJECT_PREFERENCES },
    metadata: {
      shareId: "share-xyz-987",
      shareUrl: "https://share.geolibre.app/p/share-xyz-987",
      shareVisibility: "unlisted",
      shareOwnerToken: "tok-secret-123",
      author: "HydroTeam",
      organization: "Water Institute",
      createdYear: 2026,
    },
    ...patch,
  };
}

describe("Issue #1528: Project Duplication & Detached Copies", () => {
  it("generates a new unique UUID for the detached project copy", () => {
    const original = sampleProject();
    const copy1 = detachProjectCopy(original);
    const copy2 = detachProjectCopy(original);

    assert.ok(copy1.id);
    assert.ok(copy2.id);
    assert.notEqual(copy1.id, original.id);
    assert.notEqual(copy2.id, original.id);
    assert.notEqual(copy1.id, copy2.id);
  });

  it("appends '(copy)' suffix to the project name by default", () => {
    const original = sampleProject({ name: "Urban Flood Risk" });
    const copy = detachProjectCopy(original);
    assert.equal(copy.name, "Urban Flood Risk (copy)");
  });

  it("does not duplicate '(copy)' if the name already ends with the suffix", () => {
    const original = sampleProject({ name: "Urban Flood Risk (copy)" });
    const copy = detachProjectCopy(original);
    assert.equal(copy.name, "Urban Flood Risk (copy)");
  });

  it("respects custom nameSuffix options including empty string", () => {
    const original = sampleProject({ name: "Base Map" });
    const customSuffix = detachProjectCopy(original, { nameSuffix: "v2" });
    assert.equal(customSuffix.name, "Base Map v2");

    const noSuffix = detachProjectCopy(original, { nameSuffix: "" });
    assert.equal(noSuffix.name, "Base Map");
  });

  it("handles empty or whitespace project names with fallback defaults", () => {
    const original = sampleProject({ name: "   " });
    const copy = detachProjectCopy(original);
    assert.ok(copy.name.includes("(copy)"));
  });

  it("strips all share-specific metadata keys while retaining non-share metadata", () => {
    const original = sampleProject();
    const copy = detachProjectCopy(original);

    assert.equal(copy.metadata?.shareId, undefined);
    assert.equal(copy.metadata?.shareUrl, undefined);
    assert.equal(copy.metadata?.shareVisibility, undefined);
    assert.equal(copy.metadata?.shareOwnerToken, undefined);

    assert.equal(copy.metadata?.author, "HydroTeam");
    assert.equal(copy.metadata?.organization, "Water Institute");
    assert.equal(copy.metadata?.createdYear, 2026);
  });

  it("preserves layer stack, map view state, styles, and layer groups", () => {
    const original = sampleProject();
    const copy = detachProjectCopy(original);

    assert.deepEqual(copy.mapView, original.mapView);
    assert.equal(copy.layers.length, 1);
    assert.equal(copy.layers[0].name, "River Water Quality");
    assert.deepEqual(copy.layerGroups, original.layerGroups);
    assert.deepEqual(copy.styles, original.styles);
  });

  it("serializes cleanly and survives project JSON round-tripping", () => {
    const original = sampleProject();
    const copy = detachProjectCopy(original);
    const serialized = serializeProject(copy);
    const restored = parseProject(serialized);

    assert.equal(restored.name, "Regional Watershed Analysis (copy)");
    assert.equal(restored.metadata?.shareId, undefined);
    assert.equal(restored.layers.length, 1);
    assert.equal(restored.layers[0].name, "River Water Quality");
  });
});

describe("Issue #1528: Project Template Creation", () => {
  it("marks metadata.isTemplate = true and strips share metadata", () => {
    const original = sampleProject();
    const template = createProjectTemplate(original, { name: "Standard Watershed Template" });

    assert.equal(template.name, "Standard Watershed Template");
    assert.equal(template.metadata?.isTemplate, true);
    assert.equal(template.metadata?.shareId, undefined);
    assert.equal(template.metadata?.author, "HydroTeam");
  });

  it("strips data layers by default while retaining layer groups and styles", () => {
    const original = sampleProject();
    const template = createProjectTemplate(original);

    assert.deepEqual(template.layers, []);
    assert.deepEqual(template.layerGroups, original.layerGroups);
    assert.deepEqual(template.styles, original.styles);
    assert.equal(template.basemapStyleUrl, original.basemapStyleUrl);
  });

  it("retains data layers when stripDataLayers is explicitly set to false", () => {
    const original = sampleProject();
    const template = createProjectTemplate(original, { stripDataLayers: false });

    assert.equal(template.layers.length, 1);
    assert.equal(template.layers[0].name, "River Water Quality");
  });

  it("uses detached copy name when no custom template name is passed", () => {
    const original = sampleProject({ name: "Base Organization Map" });
    const template = createProjectTemplate(original);

    assert.equal(template.name, "Base Organization Map");
  });
});

describe("Issue #1528: Store Template Library Actions", () => {
  const sampleTemplateEntry = (id: string, name: string): ProjectTemplateEntry => ({
    id,
    name,
    description: `Pre-configured template ${name}`,
    project: createProjectTemplate(sampleProject(), { name }),
    createdAt: "2026-07-29T10:00:00Z",
    updatedAt: "2026-07-29T10:00:00Z",
  });

  beforeEach(() => {
    useAppStore.setState({ templateLibrary: [] });
  });

  it("starts with an empty templateLibrary in the store", () => {
    const library = useAppStore.getState().templateLibrary;
    assert.deepEqual(library, []);
  });

  it("saveTemplateEntry inserts a new entry into templateLibrary", () => {
    const entry1 = sampleTemplateEntry("tmpl-1", "Org Standard");
    useAppStore.getState().saveTemplateEntry(entry1);

    const library = useAppStore.getState().templateLibrary;
    assert.equal(library.length, 1);
    assert.equal(library[0].id, "tmpl-1");
    assert.equal(library[0].name, "Org Standard");
  });

  it("saveTemplateEntry updates an existing entry matching by id", () => {
    const entry1 = sampleTemplateEntry("tmpl-1", "Org Standard");
    const updated = { ...entry1, name: "Org Standard v2", description: "Updated description" };

    useAppStore.getState().saveTemplateEntry(entry1);
    useAppStore.getState().saveTemplateEntry(updated);

    const library = useAppStore.getState().templateLibrary;
    assert.equal(library.length, 1);
    assert.equal(library[0].name, "Org Standard v2");
    assert.equal(library[0].description, "Updated description");
  });

  it("deleteTemplateEntry removes the template with matching id", () => {
    const entry1 = sampleTemplateEntry("tmpl-1", "Org Standard");
    const entry2 = sampleTemplateEntry("tmpl-2", "Light Basemap Template");

    useAppStore.getState().saveTemplateEntry(entry1);
    useAppStore.getState().saveTemplateEntry(entry2);
    assert.equal(useAppStore.getState().templateLibrary.length, 2);

    useAppStore.getState().deleteTemplateEntry("tmpl-1");
    const library = useAppStore.getState().templateLibrary;
    assert.equal(library.length, 1);
    assert.equal(library[0].id, "tmpl-2");
  });

  it("setTemplateLibrary replaces the template library array wholesale", () => {
    const entry1 = sampleTemplateEntry("tmpl-1", "Org Standard");
    const entry2 = sampleTemplateEntry("tmpl-2", "Light Basemap Template");

    useAppStore.getState().setTemplateLibrary([entry1, entry2]);
    assert.equal(useAppStore.getState().templateLibrary.length, 2);

    useAppStore.getState().setTemplateLibrary([entry2]);
    assert.equal(useAppStore.getState().templateLibrary.length, 1);
    assert.equal(useAppStore.getState().templateLibrary[0].id, "tmpl-2");
  });
});
