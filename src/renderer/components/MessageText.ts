import type { UiMessage } from "../../shared/contracts";

const LOCAL_IMAGE_PATH = /(\/(?:(?:\\ )|[^\s'"<>])+?\.(?:png|jpe?g|gif|webp))(?=\s|$|[),;])/giu;
const FILE_CONTEXT_BLOCK = /(?:\r?\n)*<file name="[^"]*">[\s\S]*?<\/file>/gu;

export function localImagePaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(LOCAL_IMAGE_PATH)) {
    const path = match[1].replaceAll("\\ ", " ");
    if (!paths.includes(path)) paths.push(path);
    if (paths.length === 4) break;
  }
  return paths;
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
    .replace(LOCAL_IMAGE_PATH, "")
    .replace(FILE_CONTEXT_BLOCK, "")
    .trim();
}

export function copyableMessage(message: UiMessage): UiMessage {
  const text = visibleUserMessageText(message.text);
  return text === message.text ? message : { ...message, text };
}

export interface AsyncActivity {
  label: string;
  detail: string;
  attention?: boolean;
}

/** A message sent in the user's name by a runtime or by Tau: a quiet line instead of a bubble. */
export function parseAsyncActivity(text: string): AsyncActivity | undefined {
  if (text.startsWith("Subagent needs attention:")) {
    return { label: "Subagent needs attention", detail: text, attention: true };
  }
  // Tau's own notes, e.g. Agents Kit waking a thread whose sub-agent finished (design 1n).
  if (text.startsWith("[Tau] ")) return { label: text.slice(6).split("\n")[0].replace(/\.$/u, ""), detail: text };
  if (!text.startsWith("Background task completed:")) return undefined;

  const count = /completed with (\d+) child run\(s\)/i.exec(text)?.[1];
  const label = count
    ? `${count} subagent ${count === "1" ? "run" : "runs"} completed`
    : "Background task completed";
  return { label, detail: text };
}

/** A prompt of the user's own starts a turn; a note sent in their name does not. */
export function startsTurn(message: UiMessage): boolean {
  return message.role === "user" && !parseAsyncActivity(message.text);
}
