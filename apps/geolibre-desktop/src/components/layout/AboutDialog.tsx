import {
  Button,
  type ButtonProps,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@geolibre/ui";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckCircle2, ExternalLink, Info, Map, RefreshCw } from "lucide-react";
import { useState } from "react";

const LINKS = [
  {
    label: "Home page",
    href: "https://geolibre.app",
  },
  {
    label: "GitHub repository",
    href: "https://github.com/opengeos/GeoLibre",
  },
];

const UPDATE_URL = "https://geolibre.app/downloads/";
const LATEST_RELEASE_URL =
  "https://api.github.com/repos/opengeos/GeoLibre/releases/latest";
const APP_VERSION = __GEOLIBRE_VERSION__;

type UpdateStatus = "idle" | "checking" | "current" | "available" | "error";

interface GitHubRelease {
  tag_name?: unknown;
}

interface AboutDialogProps {
  buttonClassName?: string;
  buttonSize?: ButtonProps["size"];
  iconClassName?: string;
  showLabels?: boolean;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function openExternalLink(url: string) {
  if (isTauri()) {
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function parseVersion(version: string): [number, number, number] | null {
  const match = version.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i);
  if (!match) return null;

  return [
    Number(match[1]),
    Number(match[2] ?? 0),
    Number(match[3] ?? 0),
  ];
}

function compareVersions(currentVersion: string, latestVersion: string): number {
  const current = parseVersion(currentVersion);
  const latest = parseVersion(latestVersion);
  if (!current || !latest) return currentVersion.localeCompare(latestVersion);

  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== latest[index]) return current[index] - latest[index];
  }

  return 0;
}

function formatVersion(version: string): string {
  const trimmedVersion = version.trim();
  return trimmedVersion.startsWith("v") ? trimmedVersion : `v${trimmedVersion}`;
}

export function AboutDialog({
  buttonClassName,
  buttonSize = "sm",
  iconClassName,
  showLabels = true,
}: AboutDialogProps) {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const handleCheckForUpdates = async () => {
    setUpdateStatus("checking");
    setLatestVersion(null);
    setUpdateError(null);

    try {
      const response = await fetch(LATEST_RELEASE_URL, {
        headers: { Accept: "application/vnd.github+json" },
      });

      if (!response.ok) {
        throw new Error(`GitHub returned ${response.status}.`);
      }

      const release = (await response.json()) as GitHubRelease;
      if (typeof release.tag_name !== "string" || !release.tag_name.trim()) {
        throw new Error("The latest release does not include a version tag.");
      }

      const nextLatestVersion = formatVersion(release.tag_name);

      setLatestVersion(nextLatestVersion);
      setUpdateStatus(
        compareVersions(APP_VERSION, release.tag_name) < 0
          ? "available"
          : "current",
      );
    } catch (error) {
      console.error("Failed to check for updates", error);
      setUpdateStatus("error");
      setUpdateError(
        error instanceof Error
          ? error.message
          : "Could not check for updates.",
      );
    }
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          className={buttonClassName}
          variant="ghost"
          size={buttonSize}
          aria-label="About"
        >
          <Info className={iconClassName ?? "h-3.5 w-3.5 sm:mr-1"} />
          {showLabels ? <span className="hidden sm:inline">About</span> : null}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Map className="h-5 w-5 text-primary" />
            About GeoLibre
          </DialogTitle>
          <DialogDescription>
            GeoLibre is a lightweight cloud-native desktop GIS.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
            <span className="text-muted-foreground">Version</span>
            <span className="font-mono text-foreground">v{APP_VERSION}</span>
          </div>
          <Button
            className="w-full justify-between"
            disabled={updateStatus === "checking"}
            onClick={() => void handleCheckForUpdates()}
            type="button"
            variant="outline"
          >
            <span className="inline-flex items-center gap-2">
              <RefreshCw
                className={`h-3.5 w-3.5 ${
                  updateStatus === "checking" ? "animate-spin" : ""
                }`}
              />
              {updateStatus === "checking"
                ? "Checking for updates"
                : "Check for updates"}
            </span>
          </Button>
          {updateStatus !== "idle" && updateStatus !== "checking" ? (
            <div className="rounded-md border bg-muted/30 px-3 py-2">
              {updateStatus === "current" ? (
                <div className="flex items-center gap-2 text-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                  <span>
                    You are up to date
                    {latestVersion ? ` (${latestVersion}).` : "."}
                  </span>
                </div>
              ) : null}
              {updateStatus === "available" ? (
                <div className="space-y-2">
                  <div className="text-foreground">
                    {latestVersion} is available. You are running v
                    {APP_VERSION}.
                  </div>
                  <Button
                    className="w-full justify-between"
                    onClick={() => void openExternalLink(UPDATE_URL)}
                    type="button"
                    variant="default"
                  >
                    <span>Download update</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : null}
              {updateStatus === "error" ? (
                <div className="space-y-2">
                  <div className="text-foreground">
                    Could not check for updates.
                  </div>
                  {updateError ? (
                    <div className="text-xs text-muted-foreground">
                      {updateError}
                    </div>
                  ) : null}
                  <Button
                    className="w-full justify-between"
                    onClick={() => void openExternalLink(UPDATE_URL)}
                    type="button"
                    variant="outline"
                  >
                    <span>View downloads</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {LINKS.map((link) => (
            <a
              key={link.href}
              className="flex items-center justify-between rounded-md border px-3 py-2 text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              href={link.href}
              onClick={(event) => {
                event.preventDefault();
                void openExternalLink(link.href);
              }}
              rel="noreferrer"
              target="_blank"
            >
              <span>{link.label}</span>
              <span className="inline-flex items-center gap-2 text-muted-foreground">
                {link.href.replace(/^https?:\/\//, "")}
                <ExternalLink className="h-3.5 w-3.5" />
              </span>
            </a>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
