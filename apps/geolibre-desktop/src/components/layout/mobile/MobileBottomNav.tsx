import { cn } from "@geolibre/ui";
import { Compass, Layers, MoreHorizontal, PlusCircle, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export type MobileNavTabId = "layers" | "style" | "add" | "field" | "more";

export interface MobileBottomNavProps {
  /** Which tab's sheet is currently open, or null when all sheets are closed. */
  activeTab: MobileNavTabId | null;
  /** Toggle or switch to a tab's sheet. */
  onSelectTab: (tab: MobileNavTabId) => void;
  /** Number of user layers in the project (rendered as a badge on Layers). */
  layerCount: number;
  /** Whether the Layers panel is enabled by layout settings. */
  showLayers: boolean;
  /** Whether the Style panel is enabled by layout settings. */
  showStyle: boolean;
  /** Whether the Add Data workflow is available in this profile/deployment. */
  showAdd: boolean;
  /** Whether Field/GPS tools are available (hidden in read-only viewer). */
  showField: boolean;
  /** Whether the More menu tab is available (requires the toolbar quick-sheet host). */
  showMore?: boolean;
}

interface NavTabSpec {
  id: MobileNavTabId;
  label: string;
  icon: ReactNode;
  badge?: number;
}

/**
 * Thumb-zone bottom navigation dock for the phone mobile shell (GeoLibre#3537).
 *
 * Replaces the stacked top/bottom side-panel rails on phones with up to 5
 * full-height 48px+ touch tabs anchored at the bottom of the workspace.
 */
export function MobileBottomNav({
  activeTab,
  onSelectTab,
  layerCount,
  showLayers,
  showStyle,
  showAdd,
  showField,
  showMore = true,
}: MobileBottomNavProps) {
  const { t } = useTranslation();

  const tabs: NavTabSpec[] = [];
  if (showLayers) {
    tabs.push({
      id: "layers",
      label: t("mobileShell.tabs.layers"),
      icon: <Layers className="h-5 w-5" />,
      badge: layerCount > 0 ? layerCount : undefined,
    });
  }
  if (showStyle) {
    tabs.push({
      id: "style",
      label: t("mobileShell.tabs.style"),
      icon: <SlidersHorizontal className="h-5 w-5" />,
    });
  }
  if (showAdd) {
    tabs.push({
      id: "add",
      label: t("mobileShell.tabs.add"),
      icon: <PlusCircle className="h-5 w-5" />,
    });
  }
  if (showField) {
    tabs.push({
      id: "field",
      label: t("mobileShell.tabs.field"),
      icon: <Compass className="h-5 w-5" />,
    });
  }
  if (showMore) {
    tabs.push({
      id: "more",
      label: t("mobileShell.tabs.more"),
      icon: <MoreHorizontal className="h-5 w-5" />,
    });
  }

  if (tabs.length === 0) return null;

  return (
    <nav
      data-testid="mobile-bottom-nav"
      aria-label={t("mobileShell.bottomNavLabel")}
      className="flex h-14 shrink-0 items-stretch border-t bg-card/95 backdrop-blur-md"
    >
      {tabs.map((tab) => {
        const active = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            data-testid={`mobile-nav-${tab.id}`}
            aria-pressed={active}
            onClick={() => onSelectTab(tab.id)}
            className={cn(
              "relative flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-accent/70",
              active ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active ? (
              <span
                aria-hidden="true"
                className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-primary"
              />
            ) : null}
            <span className="relative inline-flex items-center justify-center">
              {tab.icon}
              {tab.badge !== undefined ? (
                <span className="absolute -end-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
                  {tab.badge > 99 ? "99+" : tab.badge}
                </span>
              ) : null}
            </span>
            <span className="max-w-full truncate leading-tight">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
