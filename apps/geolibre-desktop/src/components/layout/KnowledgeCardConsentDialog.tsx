import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import { useTranslation } from "react-i18next";

interface KnowledgeCardConsentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Acknowledge the notice and proceed to open the card. */
  onConfirm: () => void;
}

/**
 * One-time privacy notice shown before the first knowledge-card lookup, since
 * opening a card sends the clicked/searched coordinate to Wikipedia's public
 * API. Mirrors the Directions and reverse-geocode consent notices.
 */
export function KnowledgeCardConsentDialog({
  open,
  onOpenChange,
  onConfirm,
}: KnowledgeCardConsentDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("knowledgeCard.noticeTitle")}</DialogTitle>
          <DialogDescription>{t("knowledgeCard.noticeDesc")}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onConfirm}>{t("toolbar.item.continue")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
