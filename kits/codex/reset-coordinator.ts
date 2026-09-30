import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

/** One account write at a time. An unanswered request retains its key across restarts. */
export class ResetCoordinator {
  private readonly running = new Map<string, Promise<unknown>>();
  constructor(private readonly stateDir: string) {}
  redeem<T>(account: string, consume: (key: string, pendingCredit?: string) => Promise<T>): Promise<T> {
    const existing = this.running.get(account);
    if (existing) return existing as Promise<T>;
    const result = this.attempt(account, consume).finally(() => this.running.delete(account));
    this.running.set(account, result);
    return result;
  }
  async hasPending(account: string): Promise<boolean> {
    const file = join(this.stateDir, "reset-attempts", createHash("sha256").update(account).digest("hex") + ".json");
    try { await readFile(file, "utf8"); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  private async attempt<T>(account: string, consume: (key: string, pendingCredit?: string) => Promise<T>): Promise<T> {
    const file = join(this.stateDir, "reset-attempts", createHash("sha256").update(account).digest("hex") + ".json");
    await mkdir(join(this.stateDir, "reset-attempts"), { recursive: true, mode: 0o700 });
    let key: string;
    let pendingCredit: string | undefined;
    try { const saved = JSON.parse(await readFile(file, "utf8")); key = saved.key; pendingCredit = saved.credit; if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(key)) throw new Error("Invalid reset attempt."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; key = randomUUID(); await writeFile(file, JSON.stringify({ key }), { mode: 0o600 }); }
    try {
      const outcome = await consume(key, pendingCredit);
      await unlink(file);
      return outcome;
    } catch (error) {
      if ((error as { settled?: boolean }).settled) await unlink(file);
      throw error;
    }
  }
}
