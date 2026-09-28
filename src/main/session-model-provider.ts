import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

interface ProviderEntry {
  parentId: string | null;
  provider?: string;
  model?: string;
}

/** The model a session's selected branch used last: its provider and, where the file names it, its id. */
export interface SessionModel {
  provider: string;
  id?: string;
}

function record(value: unknown): { id: string; entry: ProviderEntry } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string") return undefined;
  const parentId = typeof candidate.parentId === "string" ? candidate.parentId : null;
  if (candidate.type === "model_change" && typeof candidate.provider === "string") {
    return { id: candidate.id, entry: { parentId, provider: candidate.provider, ...(typeof candidate.modelId === "string" ? { model: candidate.modelId } : {}) } };
  }
  if (candidate.type === "message" && candidate.message && typeof candidate.message === "object") {
    const message = candidate.message as Record<string, unknown>;
    if (message.role === "assistant" && typeof message.provider === "string") {
      return { id: candidate.id, entry: { parentId, provider: message.provider, ...(typeof message.model === "string" ? { model: message.model } : {}) } };
    }
  }
  return { id: candidate.id, entry: { parentId } };
}

/** Reads only the entry ancestry needed to resolve the selected branch's latest model. */
export async function readSessionModel(path: string): Promise<SessionModel | undefined> {
  const entries = new Map<string, ProviderEntry>();
  let leafId: string | undefined;
  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      const parsed = record(value);
      if (!parsed) continue;
      entries.set(parsed.id, parsed.entry);
      leafId = parsed.id;
    }
  } catch {
    return undefined;
  }

  const seen = new Set<string>();
  while (leafId && !seen.has(leafId)) {
    seen.add(leafId);
    const entry = entries.get(leafId);
    if (!entry) return undefined;
    if (entry.provider) return { provider: entry.provider, ...(entry.model ? { id: entry.model } : {}) };
    leafId = entry.parentId ?? undefined;
  }
  return undefined;
}
