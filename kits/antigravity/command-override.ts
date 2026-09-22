import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Where the user told Tau to find the runtime's executable, kept in the kit's
 * state folder. An environment variable still wins, so a dev setup keeps its own.
 */
export class CommandOverride {
  private saved?: string;

  constructor(private readonly file: string, private readonly variable: string, private readonly env: NodeJS.ProcessEnv) {
    try {
      const value = (JSON.parse(readFileSync(file, "utf8")) as { command?: unknown }).command;
      if (typeof value === "string" && value.trim()) this.saved = value.trim();
    } catch { /* nothing saved yet */ }
  }

  /** The override in effect and who set it; undefined leaves the PATH lookup. */
  current(): { command: string; source: "env" | "setting" } | undefined {
    const fromEnv = this.env[this.variable]?.trim();
    if (fromEnv) return { command: fromEnv, source: "env" };
    return this.saved ? { command: this.saved, source: "setting" } : undefined;
  }

  get variableName(): string { return this.variable; }

  async set(command: string | undefined): Promise<void> {
    const value = command?.trim() || undefined;
    mkdirSync(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(value ? { command: value } : {}, null, 2)}\n`, { mode: 0o600 });
    this.saved = value;
  }
}
