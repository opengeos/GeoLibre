import { projectPathLabel, useAppStore } from "@geolibre/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import {
  BookOpen,
  Bookmark,
  Copy,
  FileCode2,
  FileInput,
  FilePen,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  HardDriveDownload,
  History,
  Import,
  LayoutGrid,
  Link2,
  Printer,
  Save,
  Share2,
  Users,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDesktopSettingsStore } from "../../../hooks/useDesktopSettings";
import { isMenuItemVisible } from "../../../lib/ui-profile";
import type { ShareHostStatus } from "../../../lib/share-geolibre";
import { formatRecentProjectTime, type ToolbarChrome } from "./constants";

// aria-describedby targets for the "sharing server unavailable" explanation.
const SHARE_UNAVAILABLE_ID = "project-menu-share-unavailable";
const GALLERY_UNAVAILABLE_ID = "project-menu-gallery-unavailable";

interface ProjectMenuProps {
  chrome: ToolbarChrome;
  collaborationEnabled: boolean;
  /**
   * Availability of the configured share host. `disabled` hides Share and the
   * Project Gallery (the deployment turned sharing off); `invalid` leaves them
   * visible but disabled with a reason, so a broken configuration is discoverable
   * rather than silently missing.
   */
  shareHostStatus: ShareHostStatus;
  onNewProject: () => void;
  onOpenFromFile: () => void;
  onOpenFromUrl: () => void;
  onOpenGallery: () => void;
  onImportQgisProject: () => void;
  onImportArcgisProject: () => void;
  onOpenRecent: (path: string) => void;
  onOpenHistory: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onDuplicate?: () => void;
  onSaveAsTemplate?: () => void;
  onShare: () => void;
  onExportHtml: () => void;
  onCollaborate: () => void;
  onPrintLayout: () => void;
  onOpenOfflineBasemap: () => void;
}

/** The Project menu: new/open/save/share, recent projects, print, and storymap. */
export function ProjectMenu({
  chrome,
  collaborationEnabled,
  shareHostStatus,
  onNewProject,
  onOpenFromFile,
  onOpenFromUrl,
  onOpenGallery,
  onImportQgisProject,
  onImportArcgisProject,
  onOpenRecent,
  onOpenHistory,
  onSave,
  onSaveAs,
  onDuplicate,
  onSaveAsTemplate,
  onShare,
  onExportHtml,
  onCollaborate,
  onPrintLayout,
  onOpenOfflineBasemap,
}: ProjectMenuProps) {
  const { t } = useTranslation();
  const projectPath = useAppStore((s) => s.projectPath);
  const recentProjects = useAppStore((s) => s.recentProjects);
  const forgetRecentProject = useAppStore((s) => s.forgetRecentProject);
  const clearRecentProjects = useAppStore((s) => s.clearRecentProjects);
  const setStorymapPanelOpen = useAppStore((s) => s.setStorymapPanelOpen);
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  const show = (id: string) => isMenuItemVisible(uiProfile, id);
  // A deployment that turned sharing off should not advertise it; one that named
  // a host we rejected should say so rather than leave the user wondering.
  const shareHidden = shareHostStatus === "disabled";
  const shareBroken = shareHostStatus === "invalid";
  // A disabled DropdownMenuItem gets `pointer-events-none`, so a native `title`
  // tooltip can never be hovered. Render the reason as its own line instead, and
  // point the item at it with aria-describedby so it is announced too. The id is
  // per-item: the Gallery entry (in the Open From submenu) and the Share entry can
  // both be mounted at once, and a duplicate id would break the association.
  const shareBrokenNote = (id: string) =>
    shareBroken ? (
      <DropdownMenuLabel id={id} className="pt-0 text-xs font-normal text-muted-foreground">
        {t("toolbar.item.shareHostUnavailable")}
      </DropdownMenuLabel>
    ) : null;
  // Group-visibility flags so the separators between groups aren't left orphaned
  // when a whole group is hidden by the active profile.
  const showSaveGroup =
    show("project.save") ||
    show("project.saveAs") ||
    show("project.duplicate") ||
    show("project.saveAsTemplate") ||
    (!shareHidden && show("project.share")) ||
    show("project.exportHtml") ||
    (collaborationEnabled && show("project.collaborate"));
  const showPrintGroup = show("project.printLayout") || show("project.offlineRegion");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={chrome.buttonClass}
          variant="ghost"
          size={chrome.buttonSize}
          aria-label={t("toolbar.menu.project")}
        >
          <Folder className={chrome.iconClassName} />
          {chrome.renderLabel(t("toolbar.menu.project"))}
        </Button>
      </DropdownMenuTrigger>
      {/* No width class — see AddDataMenu: shrink-to-fit over a fixed w-64. */}
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("toolbar.menu.project")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {show("project.new") && (
          <DropdownMenuItem onSelect={onNewProject}>
            <FilePlus2 className="me-2 h-3.5 w-3.5" />
            {t("toolbar.item.newEllipsis")}
          </DropdownMenuItem>
        )}
        {show("project.openFrom") && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderOpen className="h-3.5 w-3.5" />
              {t("toolbar.item.openFrom")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={onOpenFromFile}>
                <FileText className="me-2 h-3.5 w-3.5" />
                {t("toolbar.item.fileEllipsis")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onOpenFromUrl}>
                <Link2 className="me-2 h-3.5 w-3.5" />
                {t("toolbar.item.urlEllipsis")}
              </DropdownMenuItem>
              {!shareHidden && (
                <>
                  <DropdownMenuItem
                    onSelect={onOpenGallery}
                    disabled={shareBroken}
                    aria-describedby={shareBroken ? GALLERY_UNAVAILABLE_ID : undefined}
                  >
                    <LayoutGrid className="me-2 h-3.5 w-3.5" />
                    {t("toolbar.item.galleryEllipsis")}
                  </DropdownMenuItem>
                  {shareBrokenNote(GALLERY_UNAVAILABLE_ID)}
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {show("project.openRecent") && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={recentProjects.length === 0}>
              <History className="h-3.5 w-3.5" />
              {t("toolbar.item.openRecent")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-80">
              {recentProjects.length === 0 ? (
                <DropdownMenuItem disabled>{t("toolbar.item.noRecentProjects")}</DropdownMenuItem>
              ) : (
                recentProjects.map((project) => {
                  const openedAt = formatRecentProjectTime(project.openedAt);
                  const label = project.name || projectPathLabel(project.path);
                  return (
                    <DropdownMenuItem
                      key={project.path}
                      className="flex items-start justify-between gap-2"
                      onSelect={() => onOpenRecent(project.path)}
                      title={project.path}
                    >
                      <span className="flex min-w-0 flex-col items-start gap-0.5">
                        <span className="max-w-full truncate font-medium" title={label}>
                          {label}
                        </span>
                        <span className="flex max-w-full items-start gap-1 text-xs text-muted-foreground">
                          <History className="h-3 w-3 shrink-0" />
                          <span className="break-all text-start leading-snug" title={project.path}>
                            {openedAt ? `${openedAt} - ${project.path}` : project.path}
                          </span>
                        </span>
                      </span>
                      <button
                        type="button"
                        aria-label={t("toolbar.item.removeFromRecent", {
                          name: label,
                        })}
                        className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                        onClick={(event) => {
                          // Keep the menu open and prevent the row's onSelect
                          // (which would reopen the project) from firing.
                          event.stopPropagation();
                          event.preventDefault();
                          forgetRecentProject(project.path);
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuItem>
                  );
                })
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={recentProjects.length === 0}
                onSelect={clearRecentProjects}
              >
                {t("toolbar.item.clearRecentProjects")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {show("project.history") && (
          <DropdownMenuItem onSelect={onOpenHistory}>
            <History className="me-2 h-3.5 w-3.5" />
            {t("toolbar.item.projectHistoryEllipsis")}
          </DropdownMenuItem>
        )}
        {show("project.import") && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Import className="h-3.5 w-3.5" />
              {t("toolbar.menu.import")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={onImportQgisProject}>
                <FileInput className="me-2 h-3.5 w-3.5" />
                {t("toolbar.item.importQgisProjectEllipsis")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onImportArcgisProject}>
                <FileInput className="me-2 h-3.5 w-3.5" />
                {t("toolbar.item.importArcgisProjectEllipsis")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {showSaveGroup && <DropdownMenuSeparator />}
        {show("project.save") && (
          <DropdownMenuItem onSelect={onSave}>
            <Save className="me-2 h-3.5 w-3.5" />
            {t("common.save")}
          </DropdownMenuItem>
        )}
        {show("project.saveAs") && (
          <DropdownMenuItem onSelect={onSaveAs}>
            <FilePen className="me-2 h-3.5 w-3.5" />
            {t("toolbar.item.saveAsEllipsis")}
          </DropdownMenuItem>
        )}
        {show("project.duplicate") && onDuplicate && (
          <DropdownMenuItem onSelect={onDuplicate}>
            <Copy className="me-2 h-3.5 w-3.5" />
            {t("toolbar.item.duplicate")}
          </DropdownMenuItem>
        )}
        {show("project.saveAsTemplate") && onSaveAsTemplate && (
          <DropdownMenuItem onSelect={onSaveAsTemplate}>
            <Bookmark className="me-2 h-3.5 w-3.5" />
            {t("toolbar.item.saveAsTemplateEllipsis")}
          </DropdownMenuItem>
        )}
        {show("project.share") && !shareHidden && (
          <>
            <DropdownMenuItem
              onSelect={onShare}
              disabled={shareBroken}
              aria-describedby={shareBroken ? SHARE_UNAVAILABLE_ID : undefined}
            >
              <Share2 className="me-2 h-3.5 w-3.5" />
              {t("toolbar.item.shareEllipsis")}
            </DropdownMenuItem>
            {shareBrokenNote(SHARE_UNAVAILABLE_ID)}
          </>
        )}
        {show("project.exportHtml") && (
          <DropdownMenuItem onSelect={onExportHtml}>
            <FileCode2 className="me-2 h-3.5 w-3.5" />
            {t("toolbar.item.exportHtmlEllipsis")}
          </DropdownMenuItem>
        )}
        {collaborationEnabled && show("project.collaborate") && (
          <DropdownMenuItem onSelect={onCollaborate}>
            <Users className="me-2 h-3.5 w-3.5" />
            {t("toolbar.item.collaborateEllipsis")}
          </DropdownMenuItem>
        )}
        {showPrintGroup && <DropdownMenuSeparator />}
        {show("project.printLayout") && (
          <DropdownMenuItem onSelect={onPrintLayout}>
            <Printer className="me-2 h-3.5 w-3.5" />
            {t("toolbar.item.printLayoutEllipsis")}
          </DropdownMenuItem>
        )}
        {show("project.offlineRegion") && (
          <DropdownMenuItem onSelect={onOpenOfflineBasemap}>
            <HardDriveDownload className="me-2 h-3.5 w-3.5" />
            {t("toolbar.item.offlineBasemapEllipsis")}
          </DropdownMenuItem>
        )}
        {show("project.storymap") && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setStorymapPanelOpen(true)}>
              <BookOpen className="me-2 h-3.5 w-3.5" />
              {t("toolbar.item.storymapEllipsis")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
