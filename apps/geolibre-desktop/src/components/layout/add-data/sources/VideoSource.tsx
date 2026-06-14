import { Input, Label } from "@geolibre/ui";
import { useState } from "react";
import {
  DEFAULT_VIDEO_BOTTOM_LEFT,
  DEFAULT_VIDEO_BOTTOM_RIGHT,
  DEFAULT_VIDEO_MP4_URL,
  DEFAULT_VIDEO_TOP_LEFT,
  DEFAULT_VIDEO_TOP_RIGHT,
  DEFAULT_VIDEO_WEBM_URL,
} from "../constants";
import { createBaseLayer, parseVideoCorner } from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";

export function VideoSource() {
  const source = useAddDataSource("Video Layer");
  const [videoMp4Url, setVideoMp4Url] = useState(DEFAULT_VIDEO_MP4_URL);
  const [videoWebmUrl, setVideoWebmUrl] = useState(DEFAULT_VIDEO_WEBM_URL);
  const [videoTopLeft, setVideoTopLeft] = useState(DEFAULT_VIDEO_TOP_LEFT);
  const [videoTopRight, setVideoTopRight] = useState(DEFAULT_VIDEO_TOP_RIGHT);
  const [videoBottomRight, setVideoBottomRight] = useState(
    DEFAULT_VIDEO_BOTTOM_RIGHT,
  );
  const [videoBottomLeft, setVideoBottomLeft] = useState(
    DEFAULT_VIDEO_BOTTOM_LEFT,
  );

  const handleSubmit = source.runSubmit(() => {
    const name = source.layerName.trim() || "Video Layer";
    const primary = videoMp4Url.trim();
    if (!primary) {
      throw new Error("Enter a video URL.");
    }
    const urls = [primary];
    const webm = videoWebmUrl.trim();
    if (webm) urls.push(webm);
    // The media-src CSP is HTTPS-only, so an http:// URL would be silently
    // blocked — reject it up front with a clear message.
    if (urls.some((url) => !/^https:\/\//i.test(url))) {
      throw new Error("Video URLs must start with https://.");
    }
    const coordinates: [
      [number, number],
      [number, number],
      [number, number],
      [number, number],
    ] = [
      parseVideoCorner(videoTopLeft, "top-left"),
      parseVideoCorner(videoTopRight, "top-right"),
      parseVideoCorner(videoBottomRight, "bottom-right"),
      parseVideoCorner(videoBottomLeft, "bottom-left"),
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
      { sourceKind: "video-url", bounds },
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
          <Label htmlFor="video-mp4-url">Primary video URL</Label>
          <Input
            id="video-mp4-url"
            placeholder="https://example.com/clip.mp4"
            value={videoMp4Url}
            onChange={(event) => setVideoMp4Url(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="video-webm-url">Fallback video URL (optional)</Label>
          <Input
            id="video-webm-url"
            placeholder="https://example.com/clip.webm"
            value={videoWebmUrl}
            onChange={(event) => setVideoWebmUrl(event.target.value)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="video-top-left">Top-left (lng, lat)</Label>
            <Input
              id="video-top-left"
              value={videoTopLeft}
              onChange={(event) => setVideoTopLeft(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="video-top-right">Top-right (lng, lat)</Label>
            <Input
              id="video-top-right"
              value={videoTopRight}
              onChange={(event) => setVideoTopRight(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="video-bottom-right">Bottom-right (lng, lat)</Label>
            <Input
              id="video-bottom-right"
              value={videoBottomRight}
              onChange={(event) => setVideoBottomRight(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="video-bottom-left">Bottom-left (lng, lat)</Label>
            <Input
              id="video-bottom-left"
              value={videoBottomLeft}
              onChange={(event) => setVideoBottomLeft(event.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The four corners georeference the video on the map. The video must be
          served over HTTPS and the host must allow cross-origin requests (CORS)
          for the frames to render.
        </p>
      </div>
    </AddDataSourceForm>
  );
}
