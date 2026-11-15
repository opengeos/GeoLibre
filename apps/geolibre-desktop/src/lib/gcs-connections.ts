/**
 * Google Cloud Storage connections: device-local settings for GCS buckets.
 * Simplified version of s3-connections.ts for GCS.
 */

export interface GcsConnection {
  id: string;
  name: string;
  /** GCS bucket name. */
  bucket: string;
  /** GCP project ID. */
  project: string;
  /** Cloud Run harvester backend URL (optional, for harvest/export). */
  backendUrl: string;
  /** API key for the harvester backend. */
  apiKey: string;
  /** Whether this is a public (anonymous) bucket. */
  anonymous: boolean;
}

export function gcsConnectionLabel(conn: GcsConnection): string {
  return conn.name || conn.bucket || "GCS connection";
}

export function isGcsUri(url: string): boolean {
  return /^gs:\/\//i.test(url.trim());
}

export { gcsUriToHttps } from "@geolibre/core";

export function newGcsConnection(): GcsConnection {
  return {
    id: `gcs-${crypto.randomUUID().slice(0, 8)}`,
    name: "",
    bucket: "",
    project: "ops-intelligence-crafter",
    backendUrl: "https://oic-harvester-482213551331.australia-southeast1.run.app",
    apiKey: "",
    anonymous: true,
  };
}
