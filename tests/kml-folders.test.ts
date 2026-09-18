import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOMParser } from "linkedom";
import {
  KML_FOLDER_PATH_PROPERTY,
  KML_TIME_PROPERTY,
  parseKmlText,
} from "../apps/geolibre-desktop/src/lib/kml";

globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;

describe("KML folder metadata", () => {
  it("records enclosing folders from outermost to innermost", () => {
    const collection = parseKmlText(`
      <kml xmlns="http://www.opengis.net/kml/2.2">
        <Document>
          <Folder>
            <name>Project X</name>
            <Folder>
              <name>Subfolder A</name>
              <Placemark>
                <name>Point A</name>
                <Point><coordinates>2,47,0</coordinates></Point>
              </Placemark>
              <Folder>
                <name>Subfolder A-1</name>
                <Placemark>
                  <name>Point A-1</name>
                  <Point><coordinates>10,48,0</coordinates></Point>
                </Placemark>
              </Folder>
            </Folder>
          </Folder>
        </Document>
      </kml>
    `);

    assert.deepEqual(collection.features[0]?.properties?.[KML_FOLDER_PATH_PROPERTY], [
      "Project X",
      "Subfolder A",
    ]);
    assert.deepEqual(collection.features[1]?.properties?.[KML_FOLDER_PATH_PROPERTY], [
      "Project X",
      "Subfolder A",
      "Subfolder A-1",
    ]);
  });

  it("does not add internal metadata to a top-level placemark", () => {
    const collection = parseKmlText(`
      <kml xmlns="http://www.opengis.net/kml/2.2">
        <Document>
          <Placemark>
            <name>Standalone</name>
            <Point><coordinates>2,47</coordinates></Point>
          </Placemark>
        </Document>
      </kml>
    `);

    assert.equal(collection.features[0]?.properties?.[KML_FOLDER_PATH_PROPERTY], undefined);
    assert.equal(collection.features[0]?.properties?.[KML_TIME_PROPERTY], undefined);
  });

  it("records a placemark's own or inherited time primitive", () => {
    const collection = parseKmlText(`
      <kml xmlns="http://www.opengis.net/kml/2.2">
        <Document>
          <Folder>
            <name>t0</name>
            <TimeSpan><begin>2024-01-01T00:00:00Z</begin><end>2024-01-01T01:00:00Z</end></TimeSpan>
            <Placemark>
              <name>Inherited</name>
              <Point><coordinates>2,47</coordinates></Point>
            </Placemark>
            <Placemark>
              <name>Own</name>
              <TimeStamp><when>2024-01-02</when></TimeStamp>
              <Point><coordinates>2,47</coordinates></Point>
            </Placemark>
          </Folder>
        </Document>
      </kml>
    `);

    assert.deepEqual(collection.features[0]?.properties?.[KML_TIME_PROPERTY], {
      begin: Date.UTC(2024, 0, 1),
      end: Date.UTC(2024, 0, 1, 1),
    });
    assert.deepEqual(collection.features[1]?.properties?.[KML_TIME_PROPERTY], {
      begin: Date.parse("2024-01-02"),
      end: null,
    });
  });
});
