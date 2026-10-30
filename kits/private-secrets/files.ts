import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostCommandError } from "tau/host-extension";
import { MAX_SECRET_BYTES, type SecretFileBinding, type SecretFileRequest } from "./protocol.js";

interface Request {
  view: SecretFileRequest;
  answer?: (result: SecretFileBinding | undefined) => void;
  binding?: SecretFileBinding;
  directory?: string;
  saving?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** Values exist only in the private submit call and a short-lived 0600 file. */
export class SecretFiles {
  private readonly requests = new Map<string, Request>();
  private readonly writes = new Map<string, Promise<void>>();
  private closed = false;
  private constructor(private readonly root: string, private readonly changed: () => void) {}

  static async open(root: string, changed: () => void): Promise<SecretFiles> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await lstat(root)).isDirectory()) throw new HostCommandError("The private file folder must not be a symbolic link.");
    await chmod(root, 0o700);
    const files = new SecretFiles(root, changed);
    // Per-file metadata contains no secret value. Recover only complete,
    // unexpired leases after a crash; discard abandoned writes and symlinks.
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const directory = join(root, entry.name);
      try {
        if (!entry.isDirectory() || !/^secret-[a-zA-Z0-9]+$/u.test(entry.name)) throw new Error("Not a lease directory");
        const metadata = join(directory, ".lease.json");
        const info = await lstat(metadata);
        if (!info.isFile() || info.size > 4096) throw new Error("Invalid lease metadata");
        const saved = JSON.parse(await readFile(metadata, "utf8")) as { view: SecretFileRequest; reference: string };
        const view = saved.view;
        if (!view || !/^[a-f0-9-]{36}$/u.test(view.id) || typeof view.threadId !== "string" || !view.threadId
          || typeof view.label !== "string" || view.label.length > 120 || typeof view.reason !== "string" || view.reason.length > 500
          || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u.test(view.filename) || !/^[a-f0-9-]{36}$/u.test(saved.reference)
          || view.status !== "ready" || !Number.isInteger(view.lifetimeMinutes) || view.lifetimeMinutes < 15 || view.lifetimeMinutes > 1440
          || !Number.isFinite(view.expiresAt) || view.expiresAt <= Date.now() || view.expiresAt > Date.now() + 86_400_000
          || files.requests.size >= 32) throw new Error("Invalid or expired lease");
        const path = join(directory, view.filename);
        const file = await lstat(path);
        if (!file.isFile() || file.size > MAX_SECRET_BYTES) throw new Error("Invalid private file");
        await chmod(directory, 0o700);
        await chmod(path, 0o600);
        const request: Request = { view: { ...view, saved: true }, directory, binding: { secretRef: saved.reference, path, expiresAt: view.expiresAt } };
        request.timer = setTimeout(() => { void files.finish(request, "ended").catch(() => undefined); }, view.expiresAt - Date.now());
        request.timer.unref?.();
        files.requests.set(view.id, request);
      } catch { await rm(directory, { recursive: true, force: true }); }
    }
    return files;
  }

  list(): SecretFileRequest[] { return [...this.requests.values()].map(({ view }) => ({ ...view })); }

  async request(threadId: string, input: { label: string; reason: string; filename: string; lifetimeMinutes: number }, signal?: AbortSignal): Promise<SecretFileBinding | undefined> {
    if (this.closed || signal?.aborted) throw new HostCommandError("The secret request ended.");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u.test(input.filename)) throw new HostCommandError("Use a filename without folders or spaces.");
    if (!Number.isInteger(input.lifetimeMinutes) || input.lifetimeMinutes < 15 || input.lifetimeMinutes > 1440) throw new HostCommandError("Choose a lifetime between 15 minutes and 24 hours.");
    if ([...this.requests.values()].some(({ view }) => view.threadId === threadId && view.status === "pending")) throw new HostCommandError("A private secret request is already waiting in this thread.");
    if ([...this.requests.values()].filter(({ view, directory }) => view.status === "pending" || view.status === "ready" || directory).length >= 32) throw new HostCommandError("Too many private secret files are active. Release one before requesting another.");
    for (const [id, request] of this.requests) {
      if (this.requests.size < 100) break;
      if ((request.view.status === "ended" || request.view.status === "declined") && !request.directory && !request.saving && !this.writes.has(id)) this.requests.delete(id);
    }
    const request: Request = { view: { ...input, id: randomUUID(), threadId, status: "pending", expiresAt: Date.now() + 600_000 } };
    this.requests.set(request.view.id, request);
    const answer = new Promise<SecretFileBinding | undefined>((resolve) => { request.answer = resolve; });
    const cancel = () => { void this.finish(request, "ended").catch(() => undefined); };
    request.timer = setTimeout(cancel, 600_000);
    request.timer.unref?.();
    signal?.addEventListener("abort", cancel, { once: true });
    this.changed();
    try { return await answer; }
    finally { signal?.removeEventListener("abort", cancel); }
  }

  submit(id: string, value: unknown, lifetimeMinutes?: number): Promise<void> {
    if (this.writes.has(id)) return Promise.reject(new HostCommandError("This secret is already being saved."));
    const writing = this.write(id, value, lifetimeMinutes);
    this.writes.set(id, writing);
    void writing.finally(() => { if (this.writes.get(id) === writing) this.writes.delete(id); }).catch(() => undefined);
    return writing;
  }

  private async write(id: string, value: unknown, lifetimeMinutes?: number): Promise<void> {
    const request = this.requests.get(id);
    if (!request || request.view.status !== "pending" || request.view.expiresAt <= Date.now() || this.closed) throw new HostCommandError("This secret request ended.");
    if (request.saving) throw new HostCommandError("This secret is already being saved.");
    if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) throw new HostCommandError("Enter a secret of at most 64 KiB.");
    const lifetime = lifetimeMinutes ?? request.view.lifetimeMinutes;
    if (!Number.isInteger(lifetime) || lifetime < 15 || lifetime > request.view.lifetimeMinutes) throw new HostCommandError("The private file lifetime can only be shortened.");
    request.saving = true;
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(this.root, "secret-"));
      // Track ownership before any secret bytes are written. Stop and rollback
      // must retain this path even if deleting an interrupted write fails.
      request.directory = directory;
      await chmod(directory, 0o700);
      const path = join(directory, request.view.filename);
      await writeFile(path, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
      if (this.closed || request.view.status !== "pending" || request.view.expiresAt <= Date.now()) throw new HostCommandError("This secret request ended.");
      const expiresAt = Date.now() + lifetime * 60_000;
      const reference = randomUUID();
      const savedView = { ...request.view, status: "ready" as const, saved: true as const, expiresAt, lifetimeMinutes: lifetime };
      await writeFile(join(directory, ".lease.json"), JSON.stringify({ view: savedView, reference }), { mode: 0o600, flag: "wx" });
      if (this.closed || request.view.status !== "pending" || request.view.expiresAt <= Date.now()) throw new HostCommandError("This secret request ended.");
      request.directory = directory;
      request.binding = { secretRef: reference, path, expiresAt };
      request.view = savedView;
      clearTimeout(request.timer);
      request.timer = setTimeout(() => { void this.finish(request, "ended").catch(() => undefined); }, expiresAt - Date.now());
      request.timer.unref?.();
      request.answer?.({ ...request.binding });
      request.answer = undefined;
      this.changed();
    } catch {
      if (directory) {
        try {
          await rm(directory, { recursive: true, force: true });
          if (request.directory === directory) request.directory = undefined;
        } catch {
          request.directory = directory;
          request.view.status = "ended";
          request.view.cleanupFailed = true;
          request.answer?.(undefined);
          request.answer = undefined;
          this.changed();
          throw new HostCommandError("The private file could not be removed. Use Delete now to retry.");
        }
      }
      throw new HostCommandError("Couldn't create the private file. Nothing was sent to the agent. Try again.");
    } finally { request.saving = false; }
  }

  async decline(id: string): Promise<void> {
    const request = this.requests.get(id);
    if (request?.view.status === "pending") await this.finish(request, "declined");
  }

  async revoke(id: string): Promise<void> {
    const request = this.requests.get(id);
    if (request) await this.finish(request, "ended");
  }

  async release(threadId: string, reference: string): Promise<void> {
    const request = [...this.requests.values()].find((entry) => entry.binding?.secretRef === reference);
    if (!request || request.view.threadId !== threadId) throw new HostCommandError("That private file does not belong to this thread.");
    await this.finish(request, "ended");
  }

  async end(threadId: string): Promise<void> {
    const requests = [...this.requests.values()].filter(({ view }) => view.threadId === threadId);
    await Promise.all(requests.map((request) => this.finish(request, "ended")));
    await Promise.allSettled(requests.flatMap(({ view }) => this.writes.get(view.id) ?? []));
  }

  private async finish(request: Request, status: "ended" | "declined"): Promise<void> {
    clearTimeout(request.timer);
    request.view.status = status;
    request.answer?.(undefined);
    request.answer = undefined;
    // Clear the reference only after deletion succeeds, so a subsequent Stop
    // or revoke can retry a filesystem failure without disclosing the value.
    if (request.directory) {
      try { await rm(request.directory, { recursive: true, force: true }); }
      catch (error) { request.view.cleanupFailed = true; this.changed(); throw error; }
      request.directory = undefined;
      request.binding = undefined;
    }
    request.view.cleanupFailed = undefined;
    this.changed();
  }

  async cancelPending(threadId: string): Promise<void> {
    await Promise.all([...this.requests.values()].filter(({ view }) => view.threadId === threadId && view.status === "pending").map((request) => this.finish(request, "ended")));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.requests.values()].map((request) => this.finish(request, "ended")));
    await Promise.allSettled(this.writes.values());
  }
}
