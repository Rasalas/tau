import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The model and effort a Codex home's `config.toml` sets, which a new thread runs on. */
export interface CodexConfiguredModel {
  model?: string;
  effort?: string;
}

function value(raw: string): string | undefined {
  const text = raw.replace(/\s+#.*$/u, "").trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$/u.exec(text);
  if (!quoted) return undefined;
  return (quoted[1] ?? quoted[2] ?? "").replace(/\\(.)/gu, "$1").trim() || undefined;
}

/**
 * Reads `model`, `model_reasoning_effort` and the `profile` that may override
 * both from a `config.toml`. Only the keys Codex reads at the top and in
 * `[profiles.<name>]`; anything else in the file is left alone.
 */
export function parseCodexConfig(toml: string): CodexConfiguredModel {
  const tables = new Map<string, Record<string, string>>([["", {}]]);
  let table = "";
  for (const raw of toml.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[\s*([^\]]+?)\s*\]$/u.exec(line);
    if (header) {
      table = header[1]!.replace(/"/gu, "").replace(/\s*\.\s*/gu, ".");
      if (!tables.has(table)) tables.set(table, {});
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/u.exec(line);
    const parsed = pair ? value(pair[2]!) : undefined;
    if (pair && parsed !== undefined) tables.get(table)![pair[1]!] = parsed;
  }
  const top = tables.get("")!;
  const profile = top.profile ? tables.get(`profiles.${top.profile}`) ?? {} : {};
  const model = profile.model ?? top.model;
  const effort = profile.model_reasoning_effort ?? top.model_reasoning_effort;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** Codex's home for an environment: `CODEX_HOME`, else `~/.codex`. */
export function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/** What the home's `config.toml` sets; nothing when there is no such file. */
export async function readCodexConfiguredModel(home: string): Promise<CodexConfiguredModel> {
  try {
    return parseCodexConfig(await readFile(join(home, "config.toml"), "utf8"));
  } catch {
    return {};
  }
}
