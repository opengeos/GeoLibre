import { cn } from "@geolibre/ui";
import {
  Bug,
  ChevronRight,
  ClipboardList,
  Cloud,
  Cpu,
  Download,
  FilePlus2,
  FolderOpen,
  Globe,
  HardDriveDownload,
  Info,
  Layers,
  Link2,
  Map as MapIcon,
  MessageSquarePlus,
  Monitor,
  Navigation,
  PenTool,
  Puzzle,
  Ruler,
  Save,
  Search,
  Settings,
  Share2,
  Sparkles,
  Table2,
  Upload,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface SheetActionRowProps {
  icon: ReactNode;
  label: string;
  badge?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

function SheetActionRow({
  icon,
  label,
  badge,
  active,
  disabled = false,
  onClick,
}: SheetActionRowProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 active:bg-accent",
        active ? "bg-primary/10 text-primary" : "text-foreground hover:bg-accent/60",
      )}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge ? (
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {badge}
        </span>
      ) : null}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70 rtl:rotate-180" />
    </button>
  );
}

export interface MobileAddSheetProps {
  addDataReady: boolean;
  canAddVector: boolean;
  canAddRaster: boolean;
  canAddDelimited: boolean;
  canAddXyz: boolean;
  canAddWms: boolean;
  canAddGeoParquet: boolean;
  canOpenBasemaps: boolean;
  basemapsActive: boolean;
  onAddVector: () => void;
  onAddRaster: () => void;
  onAddDelimited: () => void;
  onAddXyz: () => void;
  onAddWms: () => void;
  onAddGeoParquet: () => void;
  onToggleBasemaps: () => void;
  onOpenGallery: () => void;
  onSearchAllSources: () => void;
}

/** Touch action list for adding local/remote layers and switching basemaps. */
export function MobileAddSheetContent({
  addDataReady,
  canAddVector,
  canAddRaster,
  canAddDelimited,
  canAddXyz,
  canAddWms,
  canAddGeoParquet,
  canOpenBasemaps,
  basemapsActive,
  onAddVector,
  onAddRaster,
  onAddDelimited,
  onAddXyz,
  onAddWms,
  onAddGeoParquet,
  onToggleBasemaps,
  onOpenGallery,
  onSearchAllSources,
}: MobileAddSheetProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-1 p-2">
      {canAddVector ? (
        <SheetActionRow
          icon={<Upload className="h-4 w-4" />}
          label={t("mobileShell.add.localVector")}
          disabled={!addDataReady}
          onClick={onAddVector}
        />
      ) : null}
      {canAddRaster ? (
        <SheetActionRow
          icon={<Layers className="h-4 w-4" />}
          label={t("mobileShell.add.localRaster")}
          disabled={!addDataReady}
          onClick={onAddRaster}
        />
      ) : null}
      {canAddDelimited ? (
        <SheetActionRow
          icon={<Table2 className="h-4 w-4" />}
          label={t("mobileShell.add.delimitedText")}
          disabled={!addDataReady}
          onClick={onAddDelimited}
        />
      ) : null}
      {canAddXyz ? (
        <SheetActionRow
          icon={<Globe className="h-4 w-4" />}
          label={t("mobileShell.add.xyz")}
          disabled={!addDataReady}
          onClick={onAddXyz}
        />
      ) : null}
      {canAddWms ? (
        <SheetActionRow
          icon={<Link2 className="h-4 w-4" />}
          label={t("mobileShell.add.wms")}
          disabled={!addDataReady}
          onClick={onAddWms}
        />
      ) : null}
      {canAddGeoParquet ? (
        <SheetActionRow
          icon={<Cloud className="h-4 w-4" />}
          label={t("mobileShell.add.geoParquet")}
          disabled={!addDataReady}
          onClick={onAddGeoParquet}
        />
      ) : null}
      {canOpenBasemaps ? (
        <SheetActionRow
          icon={<MapIcon className="h-4 w-4" />}
          label={t("mobileShell.add.basemaps")}
          active={basemapsActive}
          onClick={onToggleBasemaps}
        />
      ) : null}
      <SheetActionRow
        icon={<Sparkles className="h-4 w-4" />}
        label={t("mobileShell.add.gallery")}
        onClick={onOpenGallery}
      />
      <SheetActionRow
        icon={<Search className="h-4 w-4" />}
        label={t("mobileShell.add.allSources")}
        onClick={onSearchAllSources}
      />
    </div>
  );
}

export interface MobileFieldSheetProps {
  canUseGeoEditor: boolean;
  geoEditorActive: boolean;
  measureActive: boolean;
  measureDisabled: boolean;
  onOpenFieldCollection: () => void;
  onOpenGpsTracking: () => void;
  onToggleGeoEditor: () => void;
  onToggleMeasure: () => void;
  onOpenOfflineBasemap: () => void;
  onAddComment: () => void;
}

/** Touch action list for outdoor field collection, GPS tracking, and map tools. */
export function MobileFieldSheetContent({
  canUseGeoEditor,
  geoEditorActive,
  measureActive,
  measureDisabled,
  onOpenFieldCollection,
  onOpenGpsTracking,
  onToggleGeoEditor,
  onToggleMeasure,
  onOpenOfflineBasemap,
  onAddComment,
}: MobileFieldSheetProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-1 p-2">
      <SheetActionRow
        icon={<ClipboardList className="h-4 w-4" />}
        label={t("mobileShell.field.fieldCollection")}
        onClick={onOpenFieldCollection}
      />
      <SheetActionRow
        icon={<Navigation className="h-4 w-4" />}
        label={t("mobileShell.field.gpsTracking")}
        onClick={onOpenGpsTracking}
      />
      {canUseGeoEditor ? (
        <SheetActionRow
          icon={<PenTool className="h-4 w-4" />}
          label={t("mobileShell.field.geoEditor")}
          active={geoEditorActive}
          onClick={onToggleGeoEditor}
        />
      ) : null}
      <SheetActionRow
        icon={<Ruler className="h-4 w-4" />}
        label={t("mobileShell.field.measure")}
        active={measureActive}
        disabled={measureDisabled}
        onClick={onToggleMeasure}
      />
      <SheetActionRow
        icon={<HardDriveDownload className="h-4 w-4" />}
        label={t("mobileShell.field.offlineBasemap")}
        onClick={onOpenOfflineBasemap}
      />
      <SheetActionRow
        icon={<MessageSquarePlus className="h-4 w-4" />}
        label={t("mobileShell.field.addComment")}
        onClick={onAddComment}
      />
    </div>
  );
}

export interface MobileMoreSheetProps {
  canEditProject: boolean;
  canShare: boolean;
  canRunProcessing: boolean;
  canManagePlugins: boolean;
  canManageSettings: boolean;
  diagnosticsErrorCount: number;
  onOpenCommandPalette: () => void;
  onNewProject: () => void;
  onOpenFromFile: () => void;
  onOpenFromUrl: () => void;
  onSaveProject: () => void;
  onShareProject: () => void;
  onOpenProcessing: () => void;
  onOpenManagePlugins: () => void;
  onOpenSettings: () => void;
  onOpenDiagnostics: () => void;
  onSwitchToDesktopUi: () => void;
  onOpenAbout: () => void;
}

/** Touch menu sheet consolidating project, tool, and app actions on phones. */
export function MobileMoreSheetContent({
  canEditProject,
  canShare,
  canRunProcessing,
  canManagePlugins,
  canManageSettings,
  diagnosticsErrorCount,
  onOpenCommandPalette,
  onNewProject,
  onOpenFromFile,
  onOpenFromUrl,
  onSaveProject,
  onShareProject,
  onOpenProcessing,
  onOpenManagePlugins,
  onOpenSettings,
  onOpenDiagnostics,
  onSwitchToDesktopUi,
  onOpenAbout,
}: MobileMoreSheetProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4 p-2 pb-4">
      <button
        type="button"
        onClick={onOpenCommandPalette}
        className="flex min-h-12 w-full items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2 text-start text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="truncate">{t("mobileShell.more.commandPalette")}</span>
      </button>

      {canEditProject ? (
        <section className="space-y-1">
          <h3 className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("mobileShell.more.project")}
          </h3>
          <SheetActionRow
            icon={<FilePlus2 className="h-4 w-4" />}
            label={t("mobileShell.more.newProject")}
            onClick={onNewProject}
          />
          <SheetActionRow
            icon={<FolderOpen className="h-4 w-4" />}
            label={t("mobileShell.more.openFile")}
            onClick={onOpenFromFile}
          />
          <SheetActionRow
            icon={<Download className="h-4 w-4" />}
            label={t("mobileShell.more.openUrl")}
            onClick={onOpenFromUrl}
          />
          <SheetActionRow
            icon={<Save className="h-4 w-4" />}
            label={t("mobileShell.more.save")}
            onClick={onSaveProject}
          />
          {canShare ? (
            <SheetActionRow
              icon={<Share2 className="h-4 w-4" />}
              label={t("mobileShell.more.share")}
              onClick={onShareProject}
            />
          ) : null}
        </section>
      ) : null}

      {canRunProcessing || canManagePlugins ? (
        <section className="space-y-1">
          <h3 className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("mobileShell.more.tools")}
          </h3>
          {canRunProcessing ? (
            <SheetActionRow
              icon={<Cpu className="h-4 w-4" />}
              label={t("mobileShell.more.processing")}
              onClick={onOpenProcessing}
            />
          ) : null}
          {canManagePlugins ? (
            <SheetActionRow
              icon={<Puzzle className="h-4 w-4" />}
              label={t("mobileShell.more.managePlugins")}
              onClick={onOpenManagePlugins}
            />
          ) : null}
        </section>
      ) : null}

      <section className="space-y-1">
        <h3 className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("mobileShell.more.app")}
        </h3>
        {canManageSettings ? (
          <SheetActionRow
            icon={<Settings className="h-4 w-4" />}
            label={t("mobileShell.more.settings")}
            onClick={onOpenSettings}
          />
        ) : null}
        <SheetActionRow
          icon={<Bug className="h-4 w-4" />}
          label={t("mobileShell.more.diagnostics")}
          badge={diagnosticsErrorCount > 0 ? String(diagnosticsErrorCount) : undefined}
          onClick={onOpenDiagnostics}
        />
        <SheetActionRow
          icon={<Monitor className="h-4 w-4" />}
          label={t("mobileShell.more.switchToDesktopUi")}
          onClick={onSwitchToDesktopUi}
        />
        <SheetActionRow
          icon={<Info className="h-4 w-4" />}
          label={t("mobileShell.more.about")}
          onClick={onOpenAbout}
        />
      </section>
    </div>
  );
}
