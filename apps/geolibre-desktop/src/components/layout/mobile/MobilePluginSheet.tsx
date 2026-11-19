import { collapseRightPanel, getRightPanel } from "@geolibre/plugins";
import { BottomSheet } from "@geolibre/ui";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

export interface MobilePluginSheetProps {
  /** Id of the currently expanded plugin right panel, or null when none is expanded. */
  activePanelId: string | null;
  /** Shared DOM content element owned by the shell's right-panel host. */
  contentEl: HTMLElement;
}

/**
 * Hosts an expanded plugin right panel (Browser, Comments, OBIA, STAC, …)
 * inside a draggable {@link BottomSheet} when the phone mobile shell is active.
 */
export function MobilePluginSheet({ activePanelId, contentEl }: MobilePluginSheetProps) {
  const { t } = useTranslation();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const panel = activePanelId ? getRightPanel(activePanelId) : undefined;

  useEffect(() => {
    if (!activePanelId || !panel) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    wrapper.appendChild(contentEl);
  }, [activePanelId, panel, contentEl]);

  if (!activePanelId || !panel) return null;

  return (
    <BottomSheet
      open
      onOpenChange={(open) => {
        if (!open) collapseRightPanel(activePanelId);
      }}
      defaultDetent="half"
      title={panel.title || t("mobileShell.sheet.pluginTitle")}
      closeLabel={t("pluginPanel.collapse")}
      dragHandleLabel={t("mobileShell.resizeSheet")}
      data-testid="mobile-plugin-sheet"
    >
      <div ref={wrapperRef} className="min-h-0 flex-1 overflow-auto" />
    </BottomSheet>
  );
}
