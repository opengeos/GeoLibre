import { useTranslation } from "react-i18next";

interface ReleaseNotesProps {
  /** Raw release-notes body (Markdown) from the GitHub release. */
  notes: string;
}

/**
 * Render GitHub release notes as a compact, scannable changelog.
 *
 * The body is shown as plain text (never as HTML) so untrusted release content
 * cannot inject markup. Light Markdown cleanup strips heading hashes and bullet
 * markers and drops the auto-generated "Full Changelog" link line, leaving a
 * readable list of changes.
 *
 * @param notes - The raw Markdown body of the release.
 */
export function ReleaseNotes({ notes }: ReleaseNotesProps) {
  const { t } = useTranslation();
  const lines = notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Drop the auto-generated footer GitHub appends to generated notes.
    .filter((line) => !/^\*\*full changelog\*\*/i.test(line))
    // Drop bare horizontal-rule dividers (e.g. "---" between sections).
    .filter((line) => !/^-{3,}$/.test(line))
    .map((line) =>
      line
        // Strip leading Markdown heading hashes and list markers.
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*+]\s+/, "")
        // Strip leading ordered-list markers (e.g. "1. ", "42. ").
        .replace(/^\d+\.\s+/, "")
        // Collapse inline link syntax to its label: [text](url) -> text, and
        // drop the leading "!" of an image link (![alt](url) -> alt).
        .replace(/!?\[([^\]]+)\]\([^)]+\)/g, "$1")
        // Collapse inline code spans first so backtick-fenced asterisks aren't
        // misread as emphasis markers by the next pass.
        .replace(/`([^`]+)`/g, "$1")
        // Strip bold/italic emphasis markers, keeping the wrapped text. The
        // 1-3 range covers ***bold italic*** without leaving a stray marker.
        .replace(/(\*{1,3}|_{1,3})(.+?)\1/g, "$2")
        .trim(),
    )
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("updates.noChangelog")}</p>;
  }

  return (
    <ul className="max-h-40 space-y-1 overflow-y-auto pe-1 text-xs text-muted-foreground">
      {lines.map((line, index) => (
        // Release-note lines have no stable id; index keys are fine for this
        // static, read-only list.
        <li key={index} className="flex gap-1.5">
          <span aria-hidden className="select-none text-muted-foreground/60">
            •
          </span>
          <span className="text-foreground/80">{line}</span>
        </li>
      ))}
    </ul>
  );
}
