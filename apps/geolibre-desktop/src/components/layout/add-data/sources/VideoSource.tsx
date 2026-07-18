import { Input, Label } from "@geolibre/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_VIDEO_BOTTOM_LEFT,
  DEFAULT_VIDEO_BOTTOM_RIGHT,
  DEFAULT_VIDEO_MP4_URL,
  DEFAULT_VIDEO_TOP_LEFT,
  DEFAULT_VIDEO_TOP_RIGHT,
  DEFAULT_VIDEO_WEBM_URL,
} from "../constants";
import { createBaseLayer } from "../helpers";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";

export function VideoSource() {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.video.defaultName"));
  const [videoMp4Url, setVideoMp4Url] = useState("");
  const [videoWebmUrl, setVideoWebmUrl] = useState("");
  const [videoTopLeft, setVideoTopLeft] = useState("");
  const [videoTopRight, setVideoTopRight] = useState("");
  const [videoBottomRight, setVideoBottomRight] = useState("");
  const [videoBottomLeft, setVideoBottomLeft] = useState("");

  // Local, translated equivalent of helpers' parseVideoCorner: parses a
  // "longitude, latitude" corner into a [lng, lat] pair and throws localized
  // validation errors (the shared helper stays English for its unit tests).
  const parseCorner = (value: string, corner: string): [number, number] => {
    const parts = value.split(",").map((part) => part.trim());
    if (parts.length !== 2) {
      throw new Error(t("addData.video.errorCornerFormat", { corner }));
    }
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      throw new Error(t("addData.video.errorCornerNumber", { corner }));
    }
    if (lng < -180 || lng > 180) {
      throw new Error(t("addData.video.errorCornerLng", { corner }));
    }
    if (lat < -90 || lat > 90) {
      throw new Error(t("addData.video.errorCornerLat", { corner }));
    }
    return [lng, lat];
  };

  const handleSubmit = source.runSubmit(() => {
    const name = source.layerName.trim() || t("addData.video.defaultName");
    const primary = videoMp4Url.trim();
    if (!primary) {
      throw new Error(t("addData.video.errorUrl"));
    }
    const urls = [primary];
    const webm = videoWebmUrl.trim();
    if (webm) urls.push(webm);
    // The media-src CSP is HTTPS-only, so an http:// URL would be silently
    // blocked — reject it up front with a clear message.
    if (urls.some((url) => !/^https:\/\//i.test(url))) {
      throw new Error(t("addData.video.errorHttps"));
    }
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
      parseCorner(videoTopLeft, t("addData.video.cornerTopLeft")),
      parseCorner(videoTopRight, t("addData.video.cornerTopRight")),
      parseCorner(videoBottomRight, t("addData.video.cornerBottomRight")),
      parseCorner(videoBottomLeft, t("addData.video.cornerBottomLeft")),
    ];
    const lngs = coordinates.map((corner) => corner[0]);
    const lats = coordinates.map((corner) => corner[1]);
    const west = Math.min(...lngs);
    const south = Math.min(...lats);
    const east = Math.max(...lngs);
    const north = Math.max(...lats);
    const bounds: [number, number, number, number] = [west, south, east, north];
    const layer = createBaseLayer(
      name,
      "video",
      { type: "video", urls, coordinates },
      // Persist the corner bbox so "Zoom to layer" works — a video source
      // exposes no bounds for fitLayer to fall back on.
      {
        sourceKind: "video-url",
        sourceUrl: primary,
        ...(webm ? { fallbackSourceUrl: webm } : {}),
        bounds,
      },
    );
    source.shell.addLayer(layer, source.beforeLayer);
    // Skip the fit for a degenerate (zero-area) bbox, which would otherwise
    // snap to a single point at max zoom.
    if (west !== east || south !== north) {
      source.shell.mapControllerRef.current?.fitBounds(bounds);
    }
    source.shell.closeDialog();
  });

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={source.isSubmitting}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="video-mp4-url">{t("addData.video.primaryUrl")}</Label>
          <Input
            id="video-mp4-url"
            placeholder={t("addData.video.primaryUrlPlaceholder")}
            value={videoMp4Url}
            onChange={(event) => setVideoMp4Url(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="video-webm-url">{t("addData.video.fallbackUrl")}</Label>
          <Input
            id="video-webm-url"
            placeholder={t("addData.video.fallbackUrlPlaceholder")}
            value={videoWebmUrl}
            onChange={(event) => setVideoWebmUrl(event.target.value)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="video-top-left">{t("addData.video.topLeft")}</Label>
            <Input
              id="video-top-left"
              value={videoTopLeft}
              onChange={(event) => setVideoTopLeft(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="video-top-right">{t("addData.video.topRight")}</Label>
            <Input
              id="video-top-right"
              value={videoTopRight}
              onChange={(event) => setVideoTopRight(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="video-bottom-right">{t("addData.video.bottomRight")}</Label>
            <Input
              id="video-bottom-right"
              value={videoBottomRight}
              onChange={(event) => setVideoBottomRight(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="video-bottom-left">{t("addData.video.bottomLeft")}</Label>
            <Input
              id="video-bottom-left"
              value={videoBottomLeft}
              onChange={(event) => setVideoBottomLeft(event.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("addData.video.cornersNote")}</p>
        <SampleDataSelect
          samples={[
            {
              label: t("addData.video.sampleLabel"),
              value: {
                mp4: DEFAULT_VIDEO_MP4_URL,
                webm: DEFAULT_VIDEO_WEBM_URL,
                topLeft: DEFAULT_VIDEO_TOP_LEFT,
                topRight: DEFAULT_VIDEO_TOP_RIGHT,
                bottomRight: DEFAULT_VIDEO_BOTTOM_RIGHT,
                bottomLeft: DEFAULT_VIDEO_BOTTOM_LEFT,
              },
            },
          ]}
          onSelect={(sample) => {
            setVideoMp4Url(sample.mp4);
            setVideoWebmUrl(sample.webm);
            setVideoTopLeft(sample.topLeft);
            setVideoTopRight(sample.topRight);
            setVideoBottomRight(sample.bottomRight);
            setVideoBottomLeft(sample.bottomLeft);
          }}
        />
      </div>
    </AddDataSourceForm>
  );
}
