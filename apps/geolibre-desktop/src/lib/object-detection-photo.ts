import type { Detection } from "@geolibre/processing";
import type { Feature, FeatureCollection, Point } from "geojson";

/** Browser-decodable photo extensions accepted by Object Detection. */
export const DETECTION_PHOTO_EXTENSIONS = ["jpg", "jpeg", "png", "webp"] as const;

function fileExtension(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/** Whether a selected Object Detection input is a regular photo. */
export function isDetectionPhotoFileName(name: string): boolean {
  return (DETECTION_PHOTO_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}

/** MIME type for a supported Object Detection photo filename. */
export function detectionPhotoMimeType(name: string): string {
  const extension = fileExtension(name);
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  return "application/octet-stream";
}

/** Resolve a model class label, falling back when the user supplied no name. */
export function detectionClassLabel(names: string[], index: number): string {
  return names[index]?.trim() || `class_${index}`;
}

/**
 * Locate regular-photo detections at the photo's camera position.
 *
 * A GPS tag supplies only the camera point, not a ground footprint or pixel
 * scale, so manufacturing map polygons from pixel boxes would be misleading.
 * Each result is therefore a point at the photo location, with the original
 * pixel bounding box retained as attributes for inspection and export.
 *
 * @param detections YOLO boxes in source-photo pixels.
 * @param coordinate Photo camera location as `[longitude, latitude]`.
 * @param names Model class names in output order.
 * @param imageName Selected photo filename.
 * @returns One point feature per detected object.
 */
export function detectionsToPhotoFeatureCollection(
  detections: Detection[],
  coordinate: [number, number],
  names: string[],
  imageName: string,
): FeatureCollection<Point> {
  const features: Feature<Point>[] = detections.map((detection) => {
    const [minX, minY, maxX, maxY] = detection.bbox.map((value) => Number(value.toFixed(2))) as [
      number,
      number,
      number,
      number,
    ];
    return {
      type: "Feature",
      properties: {
        class: detectionClassLabel(names, detection.classIndex),
        class_index: detection.classIndex,
        score: Number(detection.score.toFixed(4)),
        image_name: imageName,
        bbox_min_x: minX,
        bbox_min_y: minY,
        bbox_max_x: maxX,
        bbox_max_y: maxY,
      },
      geometry: {
        type: "Point",
        coordinates: [coordinate[0], coordinate[1]],
      },
    };
  });
  return { type: "FeatureCollection", features };
}
