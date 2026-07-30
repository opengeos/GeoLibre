import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import { FileInput, Import } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ToolbarChrome } from "./constants";

interface ImportMenuProps {
  chrome: ToolbarChrome;
  onImportQgisProject: () => void;
}

/** Import workflows that translate third-party project formats into GeoLibre. */
export function ImportMenu({ chrome, onImportQgisProject }: ImportMenuProps) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={chrome.buttonClass}
          variant="ghost"
          size={chrome.buttonSize}
          aria-label={t("toolbar.menu.import")}
        >
          <Import className={chrome.iconClassName} />
          {chrome.renderLabel(t("toolbar.menu.import"))}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{t("toolbar.menu.import")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onImportQgisProject}>
          <FileInput className="me-2 h-3.5 w-3.5" />
          {t("toolbar.item.importQgisProjectEllipsis")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
