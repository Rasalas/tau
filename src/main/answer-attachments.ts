import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionUiAnswer, UiPromptImageAttachment } from "../shared/contracts.js";

/**
 * Files attached to the answer of a question: whoever asked reads text, so an
 * image is written to disk and every file is named by its path after the
 * typed answer, the way a prompt names attached files to Codex.
 */
export type SaveAnswerImage = (sessionId: string, image: UiPromptImageAttachment) => Promise<string>;

const EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };

/** Beside the host's temporary files, one folder per thread: the agent reads them in the turn that asked. */
export function answerImageSaver(root = join(tmpdir(), "tau-answer-files")): SaveAnswerImage {
  return async (sessionId, image) => {
    const folder = join(root, sessionId.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 120) || "thread");
    await mkdir(folder, { recursive: true });
    const stem = basename(image.name).replace(/\.[^.]*$/u, "").replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 60) || "image";
    const path = join(folder, `${stem}-${randomBytes(3).toString("hex")}${EXTENSIONS[image.mimeType] ?? ""}`);
    await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
    return path;
  };
}

/** The answer with its files named in the text; an answer without files is returned as it is. */
export async function answerWithFiles(answer: ExtensionUiAnswer, sessionId: string, save: SaveAnswerImage): Promise<ExtensionUiAnswer> {
  if (!("value" in answer) || !answer.attachments?.length) return answer;
  const paths: string[] = [];
  for (const attachment of answer.attachments) paths.push(attachment.kind === "file" ? attachment.path : await save(sessionId, attachment));
  const list = `Attached files:\n${paths.map((path) => `- ${path}`).join("\n")}`;
  return { value: answer.value.trim() ? `${answer.value}\n\n${list}` : list, ...(answer.typed !== undefined ? { typed: answer.typed } : {}) };
}
