import { randomUUID } from "node:crypto";
import { cookieImportFailure, type CookieImportResult, type CookieImportSite, type CookieImportSource, type PreviewProfiles } from "./protocol.js";
import { normalizeProfileName } from "./profiles.js";

/**
 * The window half, where cookie import runs. `inProcess` is a host that is the
 * window's own process and answers directly; otherwise the call crosses to the
 * window through `callClient`.
 */
export interface CookieImportWindow {
  inProcess: boolean;
  call(command: string, input?: unknown): Promise<unknown>;
}

/** The Preview profiles an import may write into, and what happens to the page after. */
export interface CookieImportTarget {
  profiles(): Promise<PreviewProfiles>;
  partition(profile: string): string;
  /** Reloads the page when it runs in that profile; answers whether it did. */
  reload(profile: string): Promise<boolean>;
}

/** A keychain prompt can wait on the user longer than a client call may. */
const IMPORT_TIMEOUT_MS = 6 * 60_000;

const NO_WINDOW = "[no-window] Importing cookies needs the Tau desktop app on the machine whose browsers you import from.";

const fields = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

interface Job {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The host's side of cookie import: it picks the Preview partition and hands
 * the work to the window. An import that has to wait for the keychain is
 * started there and reports back with `cookie-import-settled`, because a
 * client call gives up after thirty seconds.
 */
export class CookieImportHost {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly window: CookieImportWindow, private readonly target: CookieImportTarget) {}

  private async call(command: string, input?: unknown): Promise<unknown> {
    try {
      return await this.window.call(command, input);
    } catch (error) {
      const text = message(error);
      if (cookieImportFailure(text)) throw new Error(text, { cause: error });
      if (/^No client answered|has no command/u.test(text)) throw new Error(NO_WINDOW, { cause: error });
      throw error;
    }
  }

  async sources(): Promise<CookieImportSource[]> {
    return await this.call("cookie-sources") as CookieImportSource[];
  }

  async sites(input: unknown): Promise<CookieImportSite[]> {
    const { source, profile } = fields(input);
    return await this.call("cookie-sites", { source, profile }) as CookieImportSite[];
  }

  async import(input: unknown): Promise<CookieImportResult> {
    const { source, profile, sites, into } = fields(input);
    const name = normalizeProfileName(into);
    if (!name || !(await this.target.profiles()).profiles.includes(name)) throw new Error("[unknown-profile] That Preview profile is gone. Choose another one.");
    const request = { source, profile, sites, partition: this.target.partition(name) };
    const result = (this.window.inProcess ? await this.call("cookie-import", request) : await this.viaJob(request)) as Omit<CookieImportResult, "profile" | "reloaded">;
    const reloaded = result.imported > 0 ? await this.target.reload(name).catch(() => false) : false;
    return { ...result, profile: name, reloaded };
  }

  private viaJob(request: Record<string, unknown>): Promise<unknown> {
    const job = randomUUID();
    const settled = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.settle({ job, error: "[read-failed] The import did not finish in time." }), IMPORT_TIMEOUT_MS);
      timer.unref?.();
      this.jobs.set(job, { resolve, reject, timer });
    });
    return this.call("cookie-import-start", { ...request, job }).then(() => settled, (error: unknown) => {
      this.drop(job);
      throw error;
    });
  }

  /** The window half's report for a started import; an unknown job is a late one. */
  settle(input: unknown): void {
    const { job, result, error } = fields(input);
    const pending = typeof job === "string" ? this.jobs.get(job) : undefined;
    if (!pending) return;
    this.drop(job as string);
    if (typeof error === "string") pending.reject(new Error(error));
    else pending.resolve(result);
  }

  openAccess(): Promise<unknown> {
    return this.call("cookie-open-access");
  }

  private drop(job: string): void {
    const pending = this.jobs.get(job);
    if (pending) clearTimeout(pending.timer);
    this.jobs.delete(job);
  }

  dispose(): void {
    for (const [job] of this.jobs) this.settle({ job, error: "[read-failed] Preview stopped before the import finished." });
  }
}
