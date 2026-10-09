import type { UiMessage } from "../../shared/contracts";

const LOCAL_IMAGE_PATH = /(\/(?:(?:\\ )|[^\s'"<>])+?\.(?:png|jpe?g|gif|webp))(?=\s|$|[),;])/giu;
const FILE_CONTEXT_BLOCK = /(?:\r?\n)*<file name="[^"]*">[\s\S]*?<\/file>/gu;
// Composer Context's note for an attachment the runtime reads from disk; its path may hold spaces.
const ATTACHMENT_NOTE = /The user attached [^\n]*? It is at (\/[^\n]*?); read it from there\.[ \t]*/gu;
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/iu;

export function localImagePaths(text: string): string[] {
  const noted = [...text.matchAll(ATTACHMENT_NOTE)].map((match) => match[1]).filter((path) => IMAGE_FILE.test(path));
  const written = [...text.replace(ATTACHMENT_NOTE, "").matchAll(LOCAL_IMAGE_PATH)].map((match) => match[1].replaceAll("\\ ", " "));
  return [...new Set([...noted, ...written])].slice(0, 4);
}

export function embeddedFileContexts(text: string): string[] {
  const files: string[] = [];
  const regex = /<file name="([^"]+)">/gu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (!files.includes(match[1])) files.push(match[1]);
  }
  return files;
}

/** Text shown for a user message and therefore copied from its action menu. */
export function visibleUserMessageText(text: string): string {
  // Only trim the message boundary. Trimming every line destroys meaningful
  // indentation in fenced and indented Markdown blocks.
  return text
    .replace(ATTACHMENT_NOTE, "")
    .replace(LOCAL_IMAGE_PATH, "")
    .replace(FILE_CONTEXT_BLOCK, "")
    .trim();
}

export function copyableMessage(message: UiMessage): UiMessage {
  const text = visibleUserMessageText(message.text);
  return text === message.text ? message : { ...message, text };
}

export { parseAsyncActivity, startsTurn, type AsyncActivity } from "../../shared/message-turns";
