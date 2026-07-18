import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@geolibre/ui";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useFileNamePrompt } from "../../hooks/useFileNamePrompt";

/**
 * App-wide "choose a file name" dialog backing {@link useFileNamePrompt}. Shown
 * when a text-file export must fall back to a browser download (no native save
 * picker), so the user can still name the file. Renders nothing until a prompt
 * is requested.
 */
export function FileNamePromptDialog() {
  const { t } = useTranslation();
  const request = useFileNamePrompt((state) => state.request);
  const value = useFileNamePrompt((state) => state.value);
  const setValue = useFileNamePrompt((state) => state.setValue);
  const submit = useFileNamePrompt((state) => state.submit);
  const cancel = useFileNamePrompt((state) => state.cancel);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open: boolean) => {
        if (!open) cancel();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("fileNamePrompt.title")}</DialogTitle>
          <DialogDescription>{t("fileNamePrompt.description")}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="file-name-prompt-input">{t("fileNamePrompt.label")}</Label>
            <Input
              id="file-name-prompt-input"
              autoFocus
              maxLength={255}
              spellCheck={false}
              autoComplete="off"
              value={value}
              // Strip path separators so a typed name like "2024/bookmarks"
              // isn't silently truncated to "bookmarks" by the browser saver.
              onChange={(event) => setValue(event.target.value.replace(/[/\\]/g, ""))}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => cancel()}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!value.trim()}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
