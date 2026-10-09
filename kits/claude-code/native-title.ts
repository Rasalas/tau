import { open } from "node:fs/promises";
import { join } from "node:path";
import { claudeConfigDir } from "./history-import.js";

/** Read only title metadata from this instance's own CLI transcript. */
export async function readClaudeNativeTitle(env: NodeJS.ProcessEnv, cwd: string, sessionId: string): Promise<string | undefined> {
  if (!/^[0-9a-f-]{36}$/iu.test(sessionId)) return undefined;
  const file = join(claudeConfigDir(env), "projects", cwd.replace(/[^a-zA-Z0-9]/gu, "-"), `${sessionId}.jsonl`);
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    // Metadata is appended. Bound reads even for very long coding sessions.
    const offset = Math.max(0, size - 256 * 1024);
    const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (offset) lines.shift();
    let custom: string | undefined;
    let generated: string | undefined;
    for (const line of lines) {
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (!entry || typeof entry !== "object" || entry.sessionId && entry.sessionId !== sessionId) continue;
      if (typeof entry.customTitle === "string" && entry.customTitle.trim()) custom = entry.customTitle.trim();
      if (typeof entry.aiTitle === "string" && entry.aiTitle.trim()) generated = entry.aiTitle.trim();
    }
    // Compaction summaries describe the transcript; only explicit name
    // metadata is reliable enough to replace Tau's title generation.
    return custom ?? generated;
  } finally { await handle.close(); }
}
