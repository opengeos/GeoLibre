/**
 * Add Data → Google Drive.
 *
 * Two ways in, because the two cases have genuinely different constraints:
 *
 *  - **A link**, for a file someone shared. Nothing to sign in to, and on the
 *    desktop build nothing to configure either — the native HTTP client reaches
 *    Drive's public download host directly. A folder link is listed so an
 *    unzipped shapefile (a `.shp` sitting next to its `.dbf`/`.shx`/`.prj`) can
 *    be added as one layer rather than four broken ones.
 *  - **The Google Picker**, for the user's own files. Private Drive files are
 *    invisible to any link-based flow, and browsing a Drive from inside the app
 *    would need Google's restricted `drive.readonly` scope; the Picker grants
 *    per-file access under the non-sensitive `drive.file` scope instead.
 *
 * Downloaded bytes are handed to the shell's ordinary file-import pipeline, so
 * a Drive file behaves exactly like a dropped one: the same format detection,
 * the same shapefile/KMZ unpacking, the same oversized-dataset prompt.
 */

import { Button, Input, Label, Select } from "@geolibre/ui";
import { FolderOpen, HardDriveDownload } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  googleApiKey,
  hasBuildTimeGoogleApiKey,
  hasConfiguredOAuthClientId,
  isDrivePickerAvailable,
  openDrivePicker,
  setStoredGoogleApiKey,
} from "../../../../lib/google-drive-auth";
import {
  DriveError,
  drivePickerBlocker,
  groupFolderVectorFiles,
  parseDriveTarget,
  type DriveCredentials,
  type DriveFile,
} from "../../../../lib/google-drive";
import {
  canQueryDriveApi,
  downloadDriveFile,
  fetchDriveMetadata,
  listDriveFolder,
} from "../../../../lib/google-drive-client";
import { isRestorableVectorPath } from "../../../../lib/tauri-io";
import { canImportVectorFiles, importVectorFiles } from "../../../../lib/vector-file-import";
import { useAddDataShell } from "../context";
import { errorMessage } from "../helpers";
import { AddDataFooter } from "../shared";

type DriveMode = "link" | "browse";

/** A folder entry offered for selection, with the sidecars it drags along. */
interface FolderEntry {
  file: DriveFile;
  sidecars: DriveFile[];
}

export function GoogleDriveSource() {
  const { t } = useTranslation();
  const shell = useAddDataShell();
  // `unsupported` hides the browse mode entirely (the build cannot sign in at
  // all); `unconfigured` still shows it, disabled with an explanation, because
  // it is a deployment setting someone reading this can actually fix.
  const pickerBlocker = drivePickerBlocker(isDrivePickerAvailable(), hasConfiguredOAuthClientId());
  const pickerAvailable = pickerBlocker !== "unsupported";
  const pickerBlocked = pickerBlocker !== null;

  const [mode, setMode] = useState<DriveMode>("link");
  const [link, setLink] = useState("");
  const [apiKey, setApiKey] = useState(() => googleApiKey());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Folder-link state: the listing and which entries are ticked.
  const [folderEntries, setFolderEntries] = useState<FolderEntry[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Picker state: the token that grants access to the chosen files, and the
  // choice itself. The token is useless without the files (it reaches nothing
  // else under `drive.file`), so the two always travel together.
  const [picked, setPicked] = useState<{
    accessToken: string;
    files: DriveFile[];
  } | null>(null);

  const showApiKeyField = !hasBuildTimeGoogleApiKey();
  const target = parseDriveTarget(link);
  const isFolderLink = target?.kind === "folder";

  /**
   * The credential for the current mode.
   *
   * The picker's token is deliberately confined to browse mode. It is a
   * `drive.file` grant covering only the files picked in that session, so
   * sending it with a *link* request makes Drive answer 403 for a file that is
   * publicly shared — turning a link that would have worked keylessly into
   * "Google Drive refused access". Leaving `picked` set across a mode switch is
   * still right (the selection should survive toggling back), so the scoping
   * happens here rather than by clearing it.
   */
  const credentials = (): DriveCredentials => ({
    accessToken: mode === "browse" ? picked?.accessToken : undefined,
    apiKey: apiKey.trim() || undefined,
  });

  /**
   * Turns a coded Drive failure into a sentence. Only `DriveError` carries a
   * code — the form's own validation throws a plain `Error` already holding a
   * translated message, which passes straight through.
   */
  const describe = (err: unknown): string =>
    err instanceof DriveError
      ? t(`addData.googleDrive.error.${err.code}`)
      : errorMessage(err, t("addData.googleDrive.error.requestFailed"));

  const run = async (action: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    shell.setIsSubmitting(true);
    try {
      await action();
    } catch (err) {
      setNotice(null);
      setError(describe(err));
    } finally {
      setBusy(false);
      shell.setIsSubmitting(false);
    }
  };

  const handleBrowse = () =>
    run(async () => {
      const key = apiKey.trim();
      if (!key) throw new Error(t("addData.googleDrive.error.apiKeyRequired"));
      // Remembered before the Picker opens: the flow leaves the app entirely on
      // desktop, and losing a pasted key to an abandoned sign-in is needless.
      setStoredGoogleApiKey(key);
      const result = await openDrivePicker(key);
      setPicked(result);
      setNotice(
        result.files.length
          ? t("addData.googleDrive.chosenFiles", { count: result.files.length })
          : t("addData.googleDrive.noFilesChosen"),
      );
    });

  const handleLoadFolder = () =>
    run(async () => {
      if (!target || target.kind !== "folder") {
        throw new DriveError("unrecognizedLink");
      }
      if (!canQueryDriveApi(credentials())) {
        // Listing is the one operation with no credential-free endpoint.
        throw new Error(t("addData.googleDrive.error.apiKeyRequiredForFolder"));
      }
      const { files, truncated } = await listDriveFolder(target.id, credentials());
      const entries = groupFolderVectorFiles(files, isRestorableVectorPath);
      if (entries.length === 0) throw new DriveError("emptyFolder");
      setFolderEntries(entries);
      // Everything ticked by default: a folder link is almost always shared
      // *because* of what is in it, so the common case is one click.
      setSelectedIds(new Set(entries.map((entry) => entry.file.id)));
      setNotice(
        truncated
          ? t("addData.googleDrive.folderTruncated", { count: entries.length })
          : t("addData.googleDrive.folderLoaded", { count: entries.length }),
      );
    });

  /**
   * Downloads a file and its sidecars in turn.
   *
   * Sequential rather than parallel: a shapefile set is several files that only
   * mean anything together, and a browser opening four Drive downloads at once
   * on a slow connection is more likely to time one out than to finish sooner.
   *
   * The empty name is the credential-free case, where there was no metadata
   * call to ask; passing `undefined` lets the download fall back to Drive's
   * `Content-Disposition`, which is where the real name is.
   */
  const downloadAll = async (files: DriveFile[]): Promise<File[]> => {
    const downloaded: File[] = [];
    for (const file of files) {
      downloaded.push(await downloadDriveFile(file, credentials(), file.name || undefined));
    }
    return downloaded;
  };

  /** The files a submit should download, per mode. */
  const collectFiles = async (): Promise<DriveFile[]> => {
    if (mode === "browse") {
      if (!picked?.files.length) throw new Error(t("addData.googleDrive.error.noSelection"));
      return picked.files;
    }

    if (!target) throw new DriveError("unrecognizedLink");

    if (target.kind === "folder") {
      if (!folderEntries) {
        throw new Error(t("addData.googleDrive.error.loadFolderFirst"));
      }
      const chosen = folderEntries.filter((entry) => selectedIds.has(entry.file.id));
      if (chosen.length === 0) {
        throw new Error(t("addData.googleDrive.error.noSelection"));
      }
      // Sidecars are not layers, so they are never listed — but a `.shp` is
      // unreadable without them, so they ride along with whatever selected it.
      return chosen.flatMap((entry) => [entry.file, ...entry.sidecars]);
    }

    // A single file needs no credential: the public host serves an "anyone
    // with the link" file to any origin. With a credential the metadata call is
    // still worth making — it names the file up front and distinguishes "not
    // shared" from "does not exist" — but without one the download reads the
    // name from Drive's Content-Disposition instead, which is enough for the
    // import pipeline to classify the format.
    return [
      canQueryDriveApi(credentials())
        ? await fetchDriveMetadata(target.id, credentials())
        : { id: target.id, name: "", mimeType: "" },
    ];
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(async () => {
      // Checked here rather than relying on the pipeline's own guard, whose
      // message is a developer-facing invariant with no translation.
      if (!canImportVectorFiles()) throw new DriveError("mapNotReady");
      const files = await downloadAll(await collectFiles());
      const added = await importVectorFiles(files);
      if (added === 0) throw new Error(t("addData.googleDrive.error.noLayers"));
      shell.closeDialog();
    });
  };

  const toggleEntry = (id: string, selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const submitDisabled =
    busy ||
    (mode === "browse"
      ? !picked?.files.length
      : !target || (isFolderLink && (!folderEntries || selectedIds.size === 0)));

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      {pickerAvailable ? (
        <div className="space-y-1.5">
          <Label htmlFor="google-drive-mode">{t("addData.common.sourceType")}</Label>
          <Select
            id="google-drive-mode"
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as DriveMode);
              setError(null);
              setNotice(null);
            }}
          >
            <option value="link">{t("addData.googleDrive.modeLink")}</option>
            <option value="browse">{t("addData.googleDrive.modeBrowse")}</option>
          </Select>
        </div>
      ) : null}

      {mode === "link" ? (
        <div className="space-y-1.5">
          <Label htmlFor="google-drive-link">{t("addData.googleDrive.link")}</Label>
          <Input
            id="google-drive-link"
            placeholder={t("addData.googleDrive.linkPlaceholder")}
            value={link}
            onChange={(event) => {
              setLink(event.target.value);
              // A new link invalidates the listing shown for the previous one.
              setFolderEntries(null);
              setSelectedIds(new Set());
              setNotice(null);
            }}
          />
          <p className="text-xs text-muted-foreground">{t("addData.googleDrive.linkHelp")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleBrowse()}
            disabled={busy || pickerBlocked}
          >
            <FolderOpen className="me-2 h-3.5 w-3.5" />
            {t("addData.googleDrive.browse")}
          </Button>
          <p className="text-xs text-muted-foreground">
            {pickerBlocker === "unconfigured"
              ? t("addData.googleDrive.pickerUnconfigured")
              : t("addData.googleDrive.browseHelp")}
          </p>
          {picked?.files.length ? (
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border/60 p-2 text-xs">
              {picked.files.map((file) => (
                <li key={file.id} className="truncate">
                  {file.name}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      {mode === "link" && isFolderLink ? (
        <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleLoadFolder()}
            disabled={busy}
          >
            <HardDriveDownload className="me-2 h-3.5 w-3.5" />
            {t("addData.googleDrive.loadFolder")}
          </Button>
          {folderEntries ? (
            <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border/60 p-2">
              {folderEntries.map((entry) => (
                <li key={entry.file.id}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(entry.file.id)}
                      onChange={(event) => toggleEntry(entry.file.id, event.target.checked)}
                    />
                    <span className="min-w-0 truncate">{entry.file.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {showApiKeyField ? (
        <div className="space-y-1.5">
          <Label htmlFor="google-drive-api-key">{t("addData.googleDrive.apiKey")}</Label>
          <Input
            id="google-drive-api-key"
            type="password"
            autoComplete="off"
            placeholder={t("addData.googleDrive.apiKeyPlaceholder")}
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setStoredGoogleApiKey(event.target.value);
            }}
          />
          <p className="text-xs text-muted-foreground">{t("addData.googleDrive.apiKeyHelp")}</p>
        </div>
      ) : null}

      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}

      <AddDataFooter error={error} submitDisabled={submitDisabled} />
    </form>
  );
}
