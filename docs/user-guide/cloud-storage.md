# Cloud Storage (Amazon S3)

GeoLibre reads data straight from Amazon S3 and S3-compatible object stores (MinIO, Cloudflare R2, Wasabi, Ceph). Public buckets need no setup; private buckets are read with an **S3 connection** you add under **Settings → Cloud Storage**.

## Where S3 URLs work

| Where | What to enter |
| --- | --- |
| **Add Data → Raster Layer** | `s3://bucket/path/image.tif` (COG / GeoTIFF) |
| **Add Data → Vector Layer** | The object URL, e.g. `https://bucket.s3.us-west-2.amazonaws.com/path/data.parquet` |
| **Add Data → PMTiles** | `s3://bucket/path/archive.pmtiles` |
| **LiDAR** (point clouds) | Through the S3 Browser, or `s3://bucket/path/cloud.copc.laz` |
| **SQL Workspace** | `read_parquet('s3://bucket/path/data.parquet')`, `ST_Read('s3://…')`, or a bare `FROM 's3://…'` |
| **Plugins → Web Services → S3 Browser** | Browse a bucket and add files with one click |

Layers keep the `s3://` URI (or the object URL) you added, never a signed URL. GeoLibre signs each read when the layer loads, so a saved or shared project carries no credentials, and a signature never expires under an open project.

## S3 connections

Open **Settings → Cloud Storage** and choose **Add connection**. Each connection has:

- **Credentials**: where its keys come from (see below).
- **Buckets**: the bucket names it signs for, comma-separated, with `*` as a wildcard (`data-*`). Leave it blank to use the connection for every bucket no other connection names. An exact bucket name beats a wildcard, and a wildcard beats a catch-all.
- **Region**: leave blank to auto-detect each bucket's region.
- **Endpoint** and **Path-style addressing**: for S3-compatible stores. Leave them blank for AWS.
- **Role to assume** and **External ID**: optional; see [IAM roles](#iam-roles).

**Test connection** lists the first bucket named in the connection, or just checks that the credentials resolve when it names no bucket.

### Credential sources

| Source | Where | Notes |
| --- | --- | --- |
| **Access keys** | Web and desktop | An access key ID, secret access key, and optional session token. |
| **AWS profile** | Desktop | A profile from `~/.aws/config` / `~/.aws/credentials` (or `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE`). Blank uses `AWS_PROFILE`, else `default`. |
| **Environment variables** | Desktop | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` from the environment GeoLibre was started with. |
| **IAM role (instance/container)** | Desktop | The role of the machine GeoLibre runs on. See [IAM roles](#iam-roles). |
| **Anonymous (public)** | Web and desktop | No signing, for public buckets on a custom endpoint. |

AWS profiles can hold:

- static access keys;
- **IAM Identity Center (SSO)**, both `sso_session` and legacy `sso_start_url` profiles;
- `credential_process`, such as aws-vault or granted;
- IAM roles (`role_arn`).

Resolving any of these needs no AWS CLI.

### Signing in with IAM Identity Center (SSO)

For an SSO profile, **Sign in with SSO** runs the same device sign-in as `aws sso login`. It opens your browser at the IAM Identity Center page and shows the code to confirm there. The token is cached in `~/.aws/sso/cache`, exactly where the AWS CLI keeps it, so signing in either way works for both. Tokens that carry a refresh token are refreshed automatically. When a session expires, reads fail with a message asking you to sign in again.

### IAM roles

GeoLibre assumes IAM roles itself with AWS STS, so no AWS CLI is needed:

- **Role profiles**: a profile with `role_arn` and `source_profile` (chains included) or `credential_source` (`Environment`, `Ec2InstanceMetadata`, `EcsContainer`). `external_id`, `role_session_name`, and `duration_seconds` are honored. A profile with `web_identity_token_file` uses `AssumeRoleWithWebIdentity`. Profiles that set `mfa_serial` still need the AWS CLI (v2) on `PATH`, which prompts for the code.
- **Role to assume**: set a role ARN, plus an external ID if its trust policy requires one, on any connection. GeoLibre resolves the connection's credentials first (keys, a profile, the environment, or an instance role), then assumes the role, for example a cross-account read-only role.
- **IAM role (instance/container)**: when GeoLibre runs on AWS, it uses the host's role in the order the AWS SDKs use:
    1. web identity: `AWS_WEB_IDENTITY_TOKEN_FILE` with `AWS_ROLE_ARN` (EKS IRSA);
    2. ECS and EKS Pod Identity container credentials;
    3. the EC2 instance profile, through IMDSv2.

Temporary credentials are refreshed shortly before they expire.

!!! note "Desktop only"
    AWS profiles, environment variables, instance roles, and assuming a role need the desktop app. Reading local files, the process environment, and instance metadata is impossible in a browser, and AWS STS does not answer browser (CORS) requests. The web app supports access keys (including temporary keys with a session token) and anonymous access.

## Default S3 Browser location

**Settings → Cloud Storage → Default S3 Browser location** (e.g. `s3://my-bucket/data/`) is where the S3 Browser opens. You can also browse to a folder and click **Set as default** in the browser. The setting is saved with your app settings. When it is blank, the browser reopens the last location you browsed.

## S3 Browser

**Plugins → Web Services → S3 Browser** lists a bucket's folders and files:

- Type `s3://bucket/prefix/` (or a bucket name, or an S3 HTTPS URL) and press **Go**.
- **List buckets** lists every bucket the selected connection's credentials can see. On the web this needs the S3 service endpoint to allow the page's origin, which AWS does not, so use the desktop app or type the bucket name.
- **Add** puts a COG/GeoTIFF, GeoParquet, GeoJSON, FlatGeobuf, GeoPackage, CSV, PMTiles, or COPC/LAZ/LAS point cloud file on the map through the same code paths as Add Data. Once a file is on the map its button reads **Added**; remove the layer and it turns back into **Add**. **Copy URI** copies the `s3://` URI for use elsewhere, such as the SQL Workspace.
- A `.geolibre` or `.geolibre.json` file shows **Open project** instead, which opens that project from the bucket.
- To add several files at once, tick their checkboxes (or **Select all**) and choose **Add selected**. They are added one after another, with progress shown under the buttons.
- **Up** goes to the parent folder; **Set as default** makes the current folder the one the browser opens at.
- The line under the location box shows whether the bucket is read with a connection's credentials or anonymously.

To have the S3 Browser open every time GeoLibre starts, turn on **Open the S3 Browser at startup** under [Settings → Startup Settings](settings.md#startup).

## Where credentials are stored

Connections are device-local and never saved in a project file.

- **Desktop app**: the secret access key and session token are kept in the operating system's credential store (Keychain, Credential Manager, Secret Service). The rest of the connection is kept with the app settings.
- **Web app**: connections, including secrets, live in the browser's local storage, where any script on the same origin could read them. Prefer short-lived keys (a session token) on the web.

Signed URLs are redacted from the diagnostics log. Shared projects never carry them, since layers store only the unsigned URL.

## CORS for private buckets (web app)

The web app, and the desktop webview for raster and PMTiles reads, fetch S3 objects directly, so the bucket's CORS configuration must allow the app's origin. A minimal rule:

```json
[
  {
    "AllowedOrigins": ["https://web.geolibre.app", "tauri://localhost", "http://tauri.localhost"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "ETag", "Last-Modified", "Accept-Ranges"],
    "MaxAgeSeconds": 3000
  }
]
```

Replace the first origin with your own deployment's origin. On the desktop app, listing and vector downloads go through the native HTTP client and need no CORS rule, but COG, PMTiles, and point cloud streaming still read from the webview and need the `tauri://localhost` / `http://tauri.localhost` origins.

When a read fails because the bucket's CORS rules block the app, GeoLibre says so — naming the bucket and the origin to allow — instead of a bare "Failed to fetch". It tells the two apart by repeating the request: if a normal request now succeeds, the failure was transient; if only a `no-cors` request (which CORS cannot block) gets an answer, the bucket is reachable and its CORS configuration is the cause.

## How it works

A private object is read through a **SigV4 presigned URL**, minted in the app from the connection's credentials and valid for up to 12 hours (or until temporary credentials expire). Every reader GeoLibre uses already accepts an HTTPS URL: the COG renderers, PMTiles, DuckDB-WASM, and the vector loader. So signing the URL is the one change that makes all of them read private data. PMTiles archives re-sign on each range read once the previous URL nears expiry.

## Limitations

- Zarr stores are not yet read from private buckets: a store is many objects, and the Zarr readers take no per-request signing hook.
- SQL globs (`read_parquet('s3://bucket/*.parquet')`) and Iceberg tables in private buckets are not supported; name individual files.
- `gs://` and `az://` URLs are still read anonymously.
