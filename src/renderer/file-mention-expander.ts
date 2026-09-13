import type { UiPromptAttachment } from "../shared/contracts.js";
import type { DocumentSourceContribution } from "./extension-system.js";

export const AT_FILE_REGEX = /(?:^|\s)@([\w./-]+)/gu;

export interface ExpandedPromptResult {
  text: string;
  attachments: UiPromptAttachment[];
}

/**
 * Searches prompt text for workspace file references matching `@path/to/file`.
 * If matching files exist in the workspace, loads their content and expands
 * text files into XML file blocks `<file name="...">...</file>` and images into attachments.
 */
export async function expandFileMentions(
  text: string,
  documentSource?: DocumentSourceContribution,
): Promise<ExpandedPromptResult> {
  if (!text.includes("@") || !documentSource) {
    return { text, attachments: [] };
  }

  const matches = [...text.matchAll(AT_FILE_REGEX)];
  if (matches.length === 0) {
    return { text, attachments: [] };
  }

  const pathsToLoad: string[] = [];
  const seenPaths = new Set<string>();

  for (const match of matches) {
    const rawPath = match[1];
    // Strip trailing punctuation like .,:;!?
    const cleaned = rawPath.replace(/[.,;:!?]+$/, "");
    const relPath = cleaned.replace(/^\.\//, "");
    if (!relPath || seenPaths.has(relPath)) continue;
    seenPaths.add(relPath);
    pathsToLoad.push(relPath);
  }

  const fileResults = await Promise.all(
    pathsToLoad.map(async (relPath) => {
      try {
        const file = await documentSource.loadFile(relPath);
        return { relPath, file };
      } catch {
        return { relPath, file: undefined };
      }
    }),
  );

  const textFiles: Array<{ path: string; content: string }> = [];
  const attachments: UiPromptAttachment[] = [];

  for (const { relPath, file } of fileResults) {
    if (!file) continue;

    if (file.kind === "text" && typeof file.text === "string") {
      textFiles.push({ path: relPath, content: file.text });
    } else if (file.kind === "image" && file.dataUrl) {
      const dataMatch = /^data:([^;]+);base64,(.+)$/.exec(file.dataUrl);
      if (dataMatch) {
        attachments.push({
          kind: "image",
          name: relPath.split("/").pop() ?? relPath,
          mimeType: dataMatch[1],
          data: dataMatch[2],
          size: file.size,
        });
      }
    }
  }

  if (textFiles.length === 0) {
    return { text, attachments };
  }

  const fileBlocks = textFiles
    .map((f) => `<file name="${f.path}">\n${f.content}\n</file>`)
    .join("\n\n");

  return {
    text: `${text}\n\n${fileBlocks}`,
    attachments,
  };
}
