import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  addArcGISAttachment,
  arcGISAttachmentObjectId,
  arcGISAttachmentSupport,
  deleteArcGISAttachments,
  downloadArcGISAttachment,
  listArcGISAttachments,
  updateArcGISAttachment,
} from "../packages/plugins/src/plugins/arcgis-attachments";
import { addArcGISLayer, setArcGISFetch } from "../packages/plugins/src/plugins/arcgis-layer";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import {
  attachmentSaveName,
  formatAttachmentSize,
  isPreviewableAttachment,
} from "../apps/geolibre-desktop/src/lib/arcgis-attachment-files";

const info = {
  objectIdField: "OBJECTID",
  geometryType: "esriGeometryPoint",
  capabilities: "Query,Create,Update,Delete",
  hasAttachments: true,
  fields: [{ name: "OBJECTID", type: "esriFieldTypeOID", editable: false }],
};
const feature = (id: number): Feature => ({
  type: "Feature",
  id,
  properties: { OBJECTID: id },
  geometry: { type: "Point", coordinates: [-84, 35] },
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });
const url = "https://example.com/arcgis/rest/services/Hydrants/FeatureServer/0";
// Not valid UTF-8: a text round trip would replace these bytes.
const PHOTO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfe]);

afterEach(() => {
  setArcGISFetch(null);
  useAppStore.setState({ layers: [] });
});

interface Stored {
  id: number;
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

/** A layer backed by a fake attachment-enabled service, holding record 7's files. */
async function load(layerInfo: Record<string, unknown> = info) {
  const files = new Map<number, Stored>([
    [1, { id: 1, name: "valve.png", contentType: "image/png", bytes: PHOTO }],
  ]);
  let nextId = 2;
  const requests: Array<{ method: string; path: string; token: string | null }> = [];
  let failNextPost: "throw" | "html" | undefined;
  setArcGISFetch(async (input, init) => {
    const request = new URL(String(input));
    const method = init?.method ?? "GET";
    const form = init?.body instanceof FormData ? init.body : undefined;
    const params =
      typeof init?.body === "string" ? new URLSearchParams(init.body) : request.searchParams;
    const token = form ? (form.get("token") as string | null) : params.get("token");
    requests.push({ method, path: request.pathname, token });
    const path = request.pathname.replace("/arcgis/rest/services/Hydrants/FeatureServer/0", "");
    if (method === "POST") {
      assert.equal(init?.redirect, "error");
      if (failNextPost) {
        const failure = failNextPost;
        failNextPost = undefined;
        if (failure === "throw") throw new TypeError("network down");
        return new Response("<html>Proxy error</html>", { status: 502 });
      }
    }
    if (path === "/query") return Response.json(fc(feature(7), feature(8)));
    if (path === "" || path === "/") return Response.json(layerInfo);
    if (path === "/7/attachments")
      return Response.json({
        attachmentInfos: [...files.values()].map((f) => ({
          id: f.id,
          name: f.name,
          contentType: f.contentType,
          size: f.bytes.length,
        })),
      });
    const download = /^\/7\/attachments\/(\d+)$/.exec(path);
    if (download) {
      const stored = files.get(Number(download[1]));
      if (!stored) return Response.json({ error: { code: 404, message: "Attachment not found." } });
      return new Response(stored.bytes.slice(), {
        headers: { "Content-Type": stored.contentType },
      });
    }
    if (path === "/7/addAttachment" || path === "/7/updateAttachment") {
      const file = form!.get("attachment") as File;
      if (file.name.endsWith(".exe"))
        return Response.json({
          [path === "/7/addAttachment" ? "addAttachmentResult" : "updateAttachmentResult"]: {
            success: false,
            error: { code: 400, description: "File type is not allowed." },
          },
        });
      const id = path === "/7/addAttachment" ? nextId++ : Number(form!.get("attachmentId"));
      files.set(id, {
        id,
        name: file.name,
        contentType: file.type || "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      return Response.json({
        [path === "/7/addAttachment" ? "addAttachmentResult" : "updateAttachmentResult"]: {
          objectId: id,
          success: true,
        },
      });
    }
    if (path === "/7/deleteAttachments") {
      return Response.json({
        deleteAttachmentResults: params
          .get("attachmentIds")!
          .split(",")
          .map(Number)
          .map((id) =>
            files.delete(id)
              ? { objectId: id, success: true }
              : { objectId: id, success: false, error: { code: -1, description: "Not found" } },
          ),
      });
    }
    return Response.json({ error: { code: 400, message: `Unexpected ${path}` } });
  });
  const id = await addArcGISLayer({ fitBounds() {} } as unknown as GeoLibreAppAPI, {
    layerType: "feature",
    sourceType: "url",
    url,
    token: "private-token",
  });
  return {
    id,
    files,
    requests,
    failNextPost: (mode: "throw" | "html") => {
      failNextPost = mode;
    },
  };
}
const layer = (id: string) => useAppStore.getState().layers.find((l) => l.id === id)!;

describe("arcGISAttachmentSupport", () => {
  it("follows Esri's capability rules: add with Create or Update, replace and delete with Update", async () => {
    const { id } = await load();
    assert.deepEqual(arcGISAttachmentSupport(layer(id)), {
      list: true,
      add: true,
      update: true,
      delete: true,
    });
    const withInfo = (patch: Record<string, unknown>, extra: Partial<GeoLibreLayer> = {}) =>
      arcGISAttachmentSupport({
        ...layer(id),
        ...extra,
        metadata: { ...layer(id).metadata, arcgisEditInfo: { ...info, ...patch } },
      });
    assert.deepEqual(withInfo({ capabilities: "Query,Create" }), {
      list: true,
      add: true,
      update: false,
      delete: false,
    });
    // Feature Delete alone does not allow deleting attachments.
    assert.deepEqual(withInfo({ capabilities: "Query,Delete" }), {
      list: true,
      add: false,
      update: false,
      delete: false,
    });
    assert.deepEqual(withInfo({ isDataVersioned: true }), {
      list: true,
      add: false,
      update: false,
      delete: false,
    });
    assert.equal(withInfo({ hasAttachments: false }), undefined);
    // A layer whose GeoLibre permissions withhold updates offers no replacement.
    assert.equal(withInfo({}, { capabilities: { update: false } })?.update, false);
    // A MapServer layer serves attachments read-only.
    const mapServer = arcGISAttachmentSupport({
      ...layer(id),
      source: {
        ...layer(id).source,
        arcgisQueryUrl: "https://example.com/arcgis/rest/services/Hydrants/MapServer/0/query",
      },
    });
    assert.deepEqual(mapServer, { list: true, add: false, update: false, delete: false });
  });

  it("keys attachments by object ID and has none for an unsaved feature", async () => {
    const { id } = await load();
    assert.equal(arcGISAttachmentObjectId(layer(id), feature(7)), 7);
    assert.equal(
      arcGISAttachmentObjectId(layer(id), { ...feature(7), properties: { name: "new" } }),
      undefined,
    );
    assert.equal(arcGISAttachmentObjectId(layer(id), undefined), undefined);
  });
});

describe("ArcGIS attachment operations", () => {
  it("lists and downloads original bytes with the connection's token", async () => {
    const { id, requests } = await load();
    const list = await listArcGISAttachments(id, 7);
    assert.deepEqual(list, [{ id: 1, name: "valve.png", contentType: "image/png", size: 7 }]);
    const blob = await downloadArcGISAttachment(id, 7, list[0]);
    assert.equal(blob.type, "image/png");
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), PHOTO);
    for (const request of requests.filter((r) => r.path.includes("/7/"))) {
      assert.equal(request.token, "private-token");
    }
  });

  it("reports a service error returned in place of a file", async () => {
    const { id } = await load();
    await assert.rejects(
      downloadArcGISAttachment(id, 7, { id: 99, contentType: "application/pdf" }),
      /Attachment not found/,
    );
  });

  it("adds, replaces and deletes by attachment ID, with duplicate names kept apart", async () => {
    const { id, files, requests } = await load();
    const first = await addArcGISAttachment(
      id,
      7,
      new File(["report"], "inspection 2026 ✓.pdf", { type: "application/pdf" }),
    );
    const second = await addArcGISAttachment(
      id,
      7,
      new File(["again"], "inspection 2026 ✓.pdf", { type: "application/pdf" }),
    );
    assert.notEqual(first, second);
    assert.equal(files.get(first)?.name, "inspection 2026 ✓.pdf");
    const multipart = requests.find((r) => r.path.endsWith("/addAttachment"));
    assert.equal(multipart?.token, "private-token");

    await updateArcGISAttachment(
      id,
      7,
      1,
      new File([PHOTO], "valve-new.png", { type: "image/png" }),
    );
    assert.equal(files.get(1)?.name, "valve-new.png");
    assert.equal(files.size, 3, "a replacement adds nothing");

    const result = await deleteArcGISAttachments(id, 7, [first, 404]);
    assert.deepEqual(result.deleted, [first]);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /^404: Not found/);
    assert.ok(files.has(second));
  });

  it("surfaces a service refusal of a file as a confirmed failure", async () => {
    const { id, files } = await load();
    await assert.rejects(
      addArcGISAttachment(id, 7, new File(["x"], "tool.exe")),
      /File type is not allowed/,
    );
    assert.equal(files.size, 1);
  });

  it("marks a lost or unreadable write response as unconfirmed, not failed", async () => {
    const service = await load();
    service.failNextPost("throw");
    await assert.rejects(
      addArcGISAttachment(service.id, 7, new File(["x"], "a.txt")),
      /could not be confirmed/,
    );
    service.failNextPost("html");
    await assert.rejects(deleteArcGISAttachments(service.id, 7, [1]), /could not be confirmed/);
  });

  it("refuses writes over plain HTTP", async () => {
    const { id } = await load();
    useAppStore.getState().updateLayer(id, {
      source: {
        ...layer(id).source,
        arcgisQueryUrl: "http://example.com/arcgis/rest/services/Hydrants/FeatureServer/0/query",
      },
    });
    await assert.rejects(addArcGISAttachment(id, 7, new File(["x"], "a.txt")), /require HTTPS/);
  });
});

describe("attachment file helpers", () => {
  it("previews raster images only, never SVG or documents", () => {
    assert.equal(isPreviewableAttachment("image/jpeg"), true);
    assert.equal(isPreviewableAttachment("IMAGE/PNG; charset=binary"), true);
    assert.equal(isPreviewableAttachment("image/svg+xml"), false);
    assert.equal(isPreviewableAttachment("application/pdf"), false);
    assert.equal(isPreviewableAttachment("text/html"), false);
  });

  it("offers a leaf file name without path or reserved characters", () => {
    assert.equal(attachmentSaveName("../../etc/passwd"), "passwd");
    assert.equal(attachmentSaveName("C:\\temp\\photo 1.jpg"), "photo 1.jpg");
    assert.equal(attachmentSaveName('re:port?<1>*"|.pdf'), "re_port__1____.pdf");
    assert.equal(attachmentSaveName("..."), "attachment");
    assert.equal(attachmentSaveName("测试 ✓.pdf"), "测试 ✓.pdf");
  });

  it("formats sizes in the largest whole unit", () => {
    assert.equal(formatAttachmentSize(512, "en"), "512 bytes");
    assert.equal(formatAttachmentSize(1536, "en"), "1.5 kB");
    assert.equal(formatAttachmentSize(5 * 1024 * 1024, "en"), "5 MB");
  });
});
