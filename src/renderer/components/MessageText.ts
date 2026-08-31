import type { UiMessage } from "../../shared/contracts";

const LOCAL_IMAGE_PATH = /(\/(?:(?:\\ )|[^\s'"<>])+?\.(?:png|jpe?g|gif|webp))(?=\s|$|[),;])/giu;

export function localImagePaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(LOCAL_IMAGE_PATH)) {
    const path = match[1].replaceAll("\\ ", " ");
    if (!paths.includes(path)) paths.push(path);
    if (paths.length === 4) break;
  }
  return paths;
}

/** Text shown for a user message and therefore copied from its action menu. */
export function visibleUserMessageText(text: string): string {
  // Only trim the message boundary. Trimming every line destroys meaningful
  // indentation in fenced and indented Markdown blocks.
  return text.replace(LOCAL_IMAGE_PATH, "").trim();
}

export function copyableMessage(message: UiMessage): UiMessage {
  const text = visibleUserMessageText(message.text);
  return text === message.text ? message : { ...message, text };
}
