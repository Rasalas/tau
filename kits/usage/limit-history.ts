import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { UsageLimitAccount, UsageLimitSample } from "./protocol.js";

const DAY = 86_400_000;
const MAX_SAMPLES = 12_000;

/** Bounded local observations. A cached provider answer is not a new measurement. */
export class LimitHistory {
  private samples: UsageLimitSample[] = [];
  private loaded = false;

  constructor(private readonly file: string, private readonly decode: (value: unknown) => UsageLimitAccount[] | undefined) {}

  async load(now: number): Promise<void> {
    if (this.loaded) return;
    try {
      const raw: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (Array.isArray(raw)) this.samples = raw.slice(-MAX_SAMPLES).flatMap((sample) => {
        if (!sample || typeof sample.source !== "string") return [];
        const account = this.decode({ accounts: [sample.account] })?.[0];
        return account && account.checkedAt > now - DAY && account.checkedAt <= now && !account.unavailable
          ? [{ source: sample.source, account }] : [];
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    this.loaded = true;
  }

  latest(source: string): UsageLimitAccount[] {
    const accounts = new Map<string, UsageLimitAccount>();
    for (const sample of this.samples) if (sample.source === source) accounts.set(sample.account.id, sample.account);
    return [...accounts.values()];
  }

  async record(answers: { source: string; accounts?: UsageLimitAccount[] }[], now: number): Promise<UsageLimitSample[]> {
    this.samples = this.samples.filter((sample) => sample.account.checkedAt > now - DAY && sample.account.checkedAt <= now);
    for (const answer of answers) {
      // A successful answer with a missing/signed-out account must not resurrect it later.
      if (!answer.accounts) continue;
      const present = new Set(answer.accounts.filter((account) => account.unavailable?.reason !== "signed-out" && account.unavailable?.reason !== "unsupported").map((account) => account.id));
      this.samples = this.samples.filter((sample) => sample.source !== answer.source || present.has(sample.account.id));
      for (const account of answer.accounts) {
        if (account.unavailable || !account.windows.length || account.checkedAt <= now - DAY || account.checkedAt > now) continue;
        const previous = [...this.samples].reverse().find((sample) => sample.source === answer.source && sample.account.id === account.id);
        if (previous && previous.account.checkedAt >= account.checkedAt) continue;
        this.samples.push({ source: answer.source, account });
      }
    }
    this.samples.sort((a, b) => a.account.checkedAt - b.account.checkedAt);
    this.samples = this.samples.slice(-MAX_SAMPLES);
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.samples));
    await rename(`${this.file}.tmp`, this.file);
    return [...this.samples];
  }
}
