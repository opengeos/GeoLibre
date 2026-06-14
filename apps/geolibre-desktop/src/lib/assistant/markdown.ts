import { marked } from "marked";
import { sanitizeStoryHtml } from "../sanitize-html";

/**
 * Render the assistant's markdown reply to sanitized HTML for the transcript.
 * The model output is treated as untrusted (it can be shaped by user data), so
 * the parsed HTML is passed through the same DOMPurify whitelist used for story
 * text — scripts, event handlers, and raw media are stripped, and links that
 * open a new tab get `rel="noopener noreferrer"`.
 *
 * @param text Markdown text from the assistant.
 * @returns Sanitized HTML safe for `dangerouslySetInnerHTML`.
 */
export function renderAssistantMarkdown(text: string): string {
  const html = marked.parse(text, { gfm: true, breaks: true }) as string;
  return sanitizeStoryHtml(html);
}
