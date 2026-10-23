import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
} from "@geolibre/ui";
import { AlertCircle, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { galleryErrorMessage } from "../../lib/gallery-errors";
import { supportsShareOAuth } from "../../lib/share-oauth";
import {
  GalleryError,
  type ProjectTransferTarget,
  type SharedProject,
  type ShareOrganization,
} from "../../lib/share-gallery";

interface TransferProjectDialogProps {
  /** The project to hand over; `null` keeps the dialog closed. */
  project: SharedProject | null;
  /** Organizations the caller administers and can transfer into. */
  organizations: ShareOrganization[];
  onOpenChange: (open: boolean) => void;
  /**
   * Perform the transfer. Resolves with the resulting status so the dialog
   * closes on success; rejects (with a coded {@link GalleryError}) so the
   * failure is shown in place.
   */
  onSubmit: (target: ProjectTransferTarget, slug: string) => Promise<"pending" | "accepted">;
}

/**
 * Choose where to transfer a project: another user (who must accept) or an
 * organization the caller administers (applied immediately). The old link keeps
 * working either way, so the dialog explains that and lets the owner pick a new
 * URL name when the destination already uses the current one.
 */
export function TransferProjectDialog({
  project,
  organizations,
  onOpenChange,
  onSubmit,
}: TransferProjectDialogProps) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<"user" | "organization">("user");
  const [username, setUsername] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [slug, setSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugConflict, setSlugConflict] = useState(false);
  const slugRef = useRef<HTMLInputElement>(null);

  // Reset to a clean form whenever the dialog opens on a different project.
  useEffect(() => {
    setKind("user");
    setUsername("");
    setOrganizationId("");
    setSlug(project?.slug ?? "");
    setSubmitting(false);
    setError(null);
    setSlugConflict(false);
  }, [project]);

  const selectedOrganization = organizationId || organizations[0]?.id || "";
  const targetReady = kind === "user" ? username.trim().length > 0 : selectedOrganization !== "";

  const submit = async () => {
    if (!project || !targetReady || submitting) return;
    const target: ProjectTransferTarget =
      kind === "user" ? { username: username.trim() } : { organizationId: selectedOrganization };
    setSubmitting(true);
    setError(null);
    setSlugConflict(false);
    try {
      await onSubmit(target, slug);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof GalleryError && err.code === "slug-conflict") {
        setSlugConflict(true);
        slugRef.current?.focus();
      }
      setError(galleryErrorMessage(err, t, supportsShareOAuth()));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={project !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("gallery.transferTitle", {
              title: project?.title || t("gallery.untitled"),
            })}
          </DialogTitle>
          <DialogDescription>
            {kind === "user"
              ? t("gallery.transferUserHint")
              : t("gallery.transferOrganizationHint")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-md bg-muted p-1">
          <Button
            type="button"
            variant={kind === "user" ? "secondary" : "ghost"}
            size="sm"
            className="flex-1"
            aria-pressed={kind === "user"}
            onClick={() => setKind("user")}
          >
            {t("gallery.transferToUser")}
          </Button>
          <Button
            type="button"
            variant={kind === "organization" ? "secondary" : "ghost"}
            size="sm"
            className="flex-1"
            aria-pressed={kind === "organization"}
            disabled={organizations.length === 0}
            onClick={() => setKind("organization")}
          >
            {t("gallery.transferToOrganization")}
          </Button>
        </div>

        <div className="space-y-1.5">
          {kind === "user" ? (
            <>
              <Label htmlFor="transfer-username">{t("gallery.transferUsername")}</Label>
              <Input
                id="transfer-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="off"
                disabled={submitting}
              />
            </>
          ) : (
            <>
              <Label htmlFor="transfer-organization">{t("gallery.transferOrganization")}</Label>
              <Select
                id="transfer-organization"
                value={selectedOrganization}
                onChange={(event) => setOrganizationId(event.target.value)}
                disabled={submitting}
              >
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.name}
                  </option>
                ))}
              </Select>
            </>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="transfer-slug">{t("gallery.transferSlug")}</Label>
          <Input
            id="transfer-slug"
            ref={slugRef}
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            disabled={submitting}
          />
          {slugConflict ? (
            <p className="text-xs text-muted-foreground">{t("gallery.transferSlugConflictHint")}</p>
          ) : null}
        </div>

        {error ? (
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {t("gallery.transferCancelDialog")}
          </Button>
          <Button type="button" disabled={submitting || !targetReady} onClick={() => void submit()}>
            {submitting ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : null}
            {t("gallery.transferSubmit")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
