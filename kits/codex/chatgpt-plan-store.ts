import { tryProcessLock, type ProcessLock } from "tau/host-extension";
import { randomUUID, createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ChatGPTRegistration {
  clientId: string;
  issuer: string;
  subject: string;
  email?: string;
  confirmed?: boolean;
  tokens?: { accessToken: string; refreshToken?: string; idToken: string; scopes: string[]; expiresAt: number };
}

/** A host has one stable ID; each runtime instance has its own registration. */
export class ChatGPTPlanStore {
  constructor(readonly directory: string) {}

  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
  }

  private path(instance: string): string {
    return join(this.directory, `${createHash("sha256").update(instance).digest("hex")}.json`);
  }

  async read(instance: string): Promise<ChatGPTRegistration | undefined> {
    try { return JSON.parse(await readFile(this.path(instance), "utf8")) as ChatGPTRegistration; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async forget(instance: string): Promise<void> { await rm(this.path(instance), { force: true }); }

  async write(instance: string, registration: ChatGPTRegistration): Promise<void> {
    await this.atomic(this.path(instance), JSON.stringify(registration));
  }

  private async atomic(path: string, value: string): Promise<void> {
    await this.prepare();
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  async hostId(): Promise<string> {
    return this.lock("host", async () => {
      const path = join(this.directory, "host.json");
      try { return JSON.parse(await readFile(path, "utf8")).id as string; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const id = `urn:uuid:${randomUUID()}`;
      await this.atomic(path, JSON.stringify({ id }));
      return id;
    });
  }

  /** The OS serializes rotating refresh tokens and releases locks on process exit. */
  async lock<T>(instance: string, run: () => Promise<T>): Promise<T> {
    await this.prepare();
    const path = `${this.path(instance)}.lock`;
    const deadline = Date.now() + 35_000;
    let held: ProcessLock | undefined;
    for (;;) {
      held = await tryProcessLock(path, { pid: process.pid, startedAt: new Date().toISOString(), app: "Tau" });
      if (held) break;
      if (Date.now() >= deadline) throw new Error("Another Tau host is updating this ChatGPT account. Try again shortly.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try { return await run(); }
    finally { held.release(); }
  }
}
