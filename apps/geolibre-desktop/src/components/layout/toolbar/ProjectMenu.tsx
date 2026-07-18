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
  FileCode2,
  FilePen,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  HardDriveDownload,
  History,
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
import { formatRecentProjectTime, type ToolbarChrome } from "./constants";

interface ProjectMenuProps {
  chrome: ToolbarChrome;
  collaborationEnabled: boolean;
  onNewProject: () => void;
  onOpenFromFile: () => void;
  onOpenFromUrl: () => void;
  onOpenGallery: () => void;
  onOpenRecent: (path: string) => void;
  onSave: () => void;
  onSaveAs: () => void;
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
  onNewProject,
  onOpenFromFile,
  onOpenFromUrl,
  onOpenGallery,
  onOpenRecent,
  onSave,
  onSaveAs,
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
  // Group-visibility flags so the separators between groups aren't left orphaned
  // when a whole group is hidden by the active profile.
  const showSaveGroup =
    show("project.save") ||
    show("project.saveAs") ||
    show("project.share") ||
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
      <DropdownMenuContent align="start" className="w-64">
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
              <DropdownMenuItem onSelect={onOpenGallery}>
                <LayoutGrid className="me-2 h-3.5 w-3.5" />
                {t("toolbar.item.galleryEllipsis")}
              </DropdownMenuItem>
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
        {show("project.share") && (
          <DropdownMenuItem onSelect={onShare}>
            <Share2 className="me-2 h-3.5 w-3.5" />
            {t("toolbar.item.shareEllipsis")}
          </DropdownMenuItem>
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
