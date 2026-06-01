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
import { ExternalLink, Info, Map } from "lucide-react";

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

const APP_VERSION = __GEOLIBRE_VERSION__;

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

export function AboutDialog({
  buttonClassName,
  buttonSize = "sm",
  iconClassName,
  showLabels = true,
}: AboutDialogProps) {
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
