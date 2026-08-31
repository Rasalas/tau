interface TranscriptMessage {
  role?: string;
  content?: unknown;
}

export interface ChatTranscriptInput {
  title?: string;
  cwd: string;
  sessionId: string;
  messages: readonly TranscriptMessage[];
  exportedAt?: Date;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const item = part as { type?: string; text?: string };
    if (item.type === "text") return item.text ?? "";
    if (item.type === "image") return "[Image attachment]";
    return "";
  }).filter(Boolean).join("\n\n");
}

function oneLine(value: string | undefined, fallback: string): string {
  return (value ?? "").replace(/\s+/gu, " ").replace(/^#+\s*/u, "").trim() || fallback;
}

/** Readable, provider-neutral Markdown inspired by Chat Trail's normalized exports. */
export function formatChatTranscript(input: ChatTranscriptInput): string {
  const messages = input.messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = contentText(message.content);
    return text.trim() ? [{ role: message.role, text }] : [];
  });
  const sections = messages.map(({ role, text }) => `## ${role === "user" ? "User" : "Assistant"}\n\n${text}`);
  const title = oneLine(input.title, "Tau conversation");
  const exportedAt = (input.exportedAt ?? new Date()).toISOString();
  const header = [
    `# ${title}`,
    `> **Project:** \`${input.cwd}\`  `,
    `> **Thread:** \`${input.sessionId}\`  `,
    `> **Exported:** ${exportedAt}`,
  ].join("\n\n");
  return [header, ...sections].join("\n\n---\n\n") + "\n";
}
