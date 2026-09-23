import { mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Per instance, the OpenCode server it connects to instead of starting one,
 * and that server's password. Kept apart from the instance settings in a
 * file only the user can read; the password never goes to a client.
 */
export interface OpenCodeServerSetting {
  url: string;
  password?: string;
}

/** An `http(s)` URL without credentials in it, or a reason. */
export function serverUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "The server URL is not a URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "The server URL starts with http:// or https://.";
  if (url.username || url.password) return "Put the password in its own field, not in the URL.";
  return undefined;
}

export class OpenCodeServerSettings {
  private servers = new Map<string, OpenCodeServerSetting>();

  constructor(private readonly file: string) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const [id, value] of Object.entries(saved)) {
        const entry = value as { url?: unknown; password?: unknown } | null;
        if (typeof entry?.url === "string" && !serverUrlProblem(entry.url)) {
          this.servers.set(id, { url: entry.url, ...(typeof entry.password === "string" && entry.password ? { password: entry.password } : {}) });
        }
      }
    } catch { /* nothing saved yet */ }
  }

  get(id: string): OpenCodeServerSetting | undefined {
    const entry = this.servers.get(id);
    return entry ? { ...entry } : undefined;
  }

  /**
   * Sets or clears the instance's server. An empty URL goes back to a server
   * Tau starts; `password` undefined keeps the saved one, empty clears it.
   */
  async set(id: string, url: string, password?: string): Promise<void> {
    const trimmed = url.trim().replace(/\/+$/u, "");
    if (!trimmed) this.servers.delete(id);
    else {
      const problem = serverUrlProblem(trimmed);
      if (problem) throw new Error(problem);
      const kept = password === undefined ? this.servers.get(id)?.password : password || undefined;
      this.servers.set(id, { url: trimmed, ...(kept ? { password: kept } : {}) });
    }
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    if (!this.servers.delete(id)) return;
    await this.persist();
  }

  private async persist(): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(Object.fromEntries(this.servers), null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
