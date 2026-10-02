import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HostBlob, HostBlobServices, HostExtensionServices, HostMachineServices, HostReadiness } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
// Test only: the setup runs through the real Project Scripts kit, as it does in the app.
import { createProjectScriptsHostExtension } from "../project-scripts/host.js";
import { createRemoteWorkHostExtension } from "./host.js";
import { REMOTE_WORK_EXTENSION_ID as ID, TRANSFER_EVENT, type IgnoredFilesView, type RepoTransfer, type TransferPreview } from "./protocol.js";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const GIT_ENV = { GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };

async function put(root: string, path: string, content: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

/**
 * The remote-work fixture in small: a bare origin, a checkout of it with two
 * commits, ignored files, an uncommitted change and an untracked file.
 */
async function fixture(dir: string, projectFile?: Record<string, unknown>) {
  const seed = join(dir, "seed");
  await mkdir(seed, { recursive: true });
  const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe", env: { ...process.env, ...GIT_ENV } }).toString().trim();
  run(seed, "init", "-q", "-b", "main");
  await put(seed, "README.md", "# Fixture\n");
  await put(seed, "src/app.js", "export const greeting = \"hello\";\n");
  await put(seed, "assets/pixel.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]));
  await put(seed, ".gitignore", ".env\n.scratch/\nnode_modules/\n");
  if (projectFile) await put(seed, ".tau/project.json", JSON.stringify(projectFile));
  run(seed, "add", "-A");
  run(seed, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "-qm", "start");
  await put(seed, "src/app.js", "export const greeting = \"hello\";\nexport const farewell = \"bye\";\n");
  run(seed, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "-qam", "bye");
  const origin = join(dir, "origin.git");
  run(dir, "clone", "-q", "--bare", seed, origin);
  const work = join(dir, "work");
  run(dir, "clone", "-q", pathToFileURL(origin).href, work);
  run(work, "config", "user.name", "Here");
  run(work, "config", "user.email", "here@example.invalid");
  await put(work, ".env", "SECRET=local\n");
  await put(work, ".scratch/issues/01.md", "# Issue\n");
  await put(work, "node_modules/x/index.js", "1\n");
  await put(work, "README.md", "# Fixture\n\nAn uncommitted line.\n");
  await put(work, "notes/draft.md", "An untracked draft.\n");
  const git = (...args: string[]) => run(work, ...args);
  return { work, origin, git, head: git("rev-parse", "HEAD") };
}

const READY: HostReadiness = { checkedAt: 0, runtimes: [], git: { version: "2.45.0", mergeTree: true }, disk: { path: "/", free: 50e9 }, display: { kind: "none" } };

/**
 * Host A and "rex", each with Remote Work Kit in its own registry. A's
 * `services.machines` reaches rex's registry as a paired device would, and
 * rex's `services.blobs` hands out what A uploaded.
 */
async function twoHosts(options: { projectFile?: Record<string, unknown>; projectScripts?: boolean; readiness?: HostReadiness | "none"; hooks?: boolean } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "tau-remote-work-")));
  made.push(dir);
  const repo = await fixture(dir, options.projectFile);
  // rex's user has global hooks; none may run for the transfer.
  const hookMark = join(dir, "hook-ran");
  const hooks = join(dir, "user-hooks");
  for (const name of ["post-checkout", "pre-commit", "reference-transaction", "post-commit"]) {
    await put(hooks, name, `#!/bin/sh\necho ${name} >> "${hookMark}"\n`);
    await chmod(join(hooks, name), 0o755);
  }
  await writeFile(join(dir, "rex-gitconfig"), `[core]\n\thooksPath = ${hooks}\n`);
  const rexEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(dir, "rex-gitconfig"), TAU_TEST_CLONE_ROOT: dir };
  const rexRoot = join(dir, "rex-home", ".tau", "remote-work");

  const device = "a-agents";
  const blobs = new Map<string, HostBlob>();
  const watchers = new Set<{ topic: string; listener: (event: { name: string; payload?: unknown }) => void }>();
  const rexEvents: PublishedKitEvent[] = [];
  const blobServices: HostBlobServices = {
    take: async (id, use, takeOptions) => {
      const blob = blobs.get(id);
      if (!blob || (takeOptions?.caller?.device && blob.device !== takeOptions.caller.device)) throw new Error(`No file ${id} here.`);
      blobs.delete(id);
      try {
        return await use(blob);
      } finally {
        await rm(blob.path, { force: true });
      }
    },
  };
  const projectNames = new Map<string, string>();
  const rexServices: Partial<HostExtensionServices> = {
    cwd: () => dir,
    rememberProjectName: (path: string, name: string) => { projectNames.set(path, name); },
    stateDir: join(dir, "rex-state"),
    blobs: blobServices,
    admitWorkspace: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    noteSubprocess: () => undefined,
    findCommand: () => undefined,
    thread: () => undefined,
    registerTurnObserver: () => () => undefined,
  };
  const rex = await activateHostKit(createRemoteWorkHostExtension({ root: rexRoot, env: rexEnv }), rexServices, (event) => {
    rexEvents.push(event);
    for (const watcher of watchers) if (watcher.topic === event.topic) watcher.listener({ name: event.name, payload: event.payload });
  });
  if (options.projectScripts) await rex.activate(createProjectScriptsHostExtension({ watch: false }));
  const paired = { kind: "workbench-client" as const, connection: "c1", pairedClient: device };
  // What crosses the socket is JSON.
  const wire = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)) as T);
  const machines: HostMachineServices = {
    self: { id: "mini-id", name: "mini", version: "0.7.0" },
    list: () => [{ id: "rex-id", name: "rex", status: "connected" }],
    subscribe: () => () => undefined,
    call: async (_machine, extensionId, command, input) => wire(await rex.invoke(extensionId, command, wire(input), paired)),
    request: async (_machine, method) => {
      if (method === "readiness" && options.readiness !== "none") return options.readiness ?? READY;
      throw new Error("unknown-method");
    },
    watch: (_machine, topic, listener) => {
      const watcher = { topic, listener };
      watchers.add(watcher);
      return () => { watchers.delete(watcher); };
    },
    upload: async (_machine, source, uploadOptions) => {
      const chunks: Buffer[] = [];
      if (source instanceof Uint8Array) chunks.push(Buffer.from(source));
      else for await (const chunk of source) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const id = randomUUID().replaceAll("-", "");
      const path = join(dir, "rex-blobs", id);
      await put(dirname(path), id, bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      blobs.set(id, { id, path, size: bytes.length, sha256, device });
      uploadOptions?.onProgress?.({ sent: bytes.length, total: bytes.length });
      return { id, size: bytes.length, sha256 };
    },
  };
  const aEvents: PublishedKitEvent[] = [];
  const a = await activateHostKit(createRemoteWorkHostExtension({ pollMs: 5 }), { machines, stateDir: join(dir, "a-state") }, (event) => aEvents.push(event));
  const call = <T>(command: string, input?: unknown) => a.invoke(ID, command, input) as Promise<T>;
  const rexGit = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, stdio: "pipe" }).toString().trim();
  return { dir, repo, rex, a, call, aEvents, rexEvents, rexRoot, rexEnv, rexServices, rexGit, hookMark, blobs, paired, machines, projectNames };
}

describe("Remote Work Kit: which repository a project is", () => {
  it("names two checkouts of one origin alike, and a project it cannot read as none", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "tau-remote-identity-")));
    made.push(dir);
    const repo = await fixture(dir);
    const other = join(dir, "elsewhere", "renamed");
    execFileSync("git", ["clone", "-q", pathToFileURL(repo.origin).href, other], { cwd: dir, stdio: "pipe" });
    const plain = join(dir, "plain");
    await mkdir(plain, { recursive: true });
    const known: Record<string, string> = { "ws-work": repo.work, "ws-other": other, "ws-plain": plain };
    const kit = await activateHostKit(createRemoteWorkHostExtension(), {
      stateDir: join(dir, "state"),
      knownWorkspacePath: async (workspace: string) => known[workspace] ?? Promise.reject(new Error("not admitted")),
    });
    const answer = await kit.invoke(ID, "project-identities", { workspaces: ["ws-work", "ws-other", "ws-plain", "ws-unknown"] }) as Record<string, string | null>;
    expect(answer["ws-work"]).toEqual(expect.any(String));
    expect(answer["ws-other"]).toBe(answer["ws-work"]);
    expect(answer["ws-plain"]).toBeNull();
    expect(answer["ws-unknown"]).toBeNull();
  });
});

describe("Remote Work Kit: a project's state to another machine and back", () => {
  it("brings the checkout's exact state to a worktree there, with the chosen ignored files, and no hook runs", async () => {
    const hosts = await twoHosts();
    const { repo, call } = hosts;
    const offered = await call<IgnoredFilesView>("ignored-files", { cwd: repo.work });
    expect(offered.candidates.map((candidate) => candidate.path)).toEqual([".env", ".scratch/"]);
    expect(offered.skipped.map((entry) => entry.path)).toEqual(["node_modules/"]);
    expect((await call<IgnoredFilesView>("set-ignored-files", { cwd: repo.work, paths: [".env", ".scratch/"] })).selected).toEqual([".env", ".scratch/"]);

    const transfer = await call<RepoTransfer>("send", { machine: "rex", cwd: join(repo.work, "src"), name: "Tidy the readme" });
    expect(transfer).toMatchObject({ state: "ready", machine: "rex-id", machineName: "rex", root: repo.work, head: repo.head, ignored: [".env", ".scratch/"] });
    expect(transfer.base).not.toBe(repo.head);
    expect(transfer.steps.map((step) => [step.id, step.state])).toEqual([
      ["state", "done"], ["check", "done"], ["mirror", "done"], ["bundle", "done"], ["upload", "done"], ["unpack", "done"], ["worktree", "done"], ["files", "done"], ["setup", "skipped"],
    ]);
    // rex could read origin, so it cloned it and the bundle carried the state commit alone.
    expect(transfer.steps.find((step) => step.id === "mirror")?.detail).toBe("Cloned from origin");
    expect(transfer.steps.find((step) => step.id === "bundle")?.detail).toMatch(/^1 commit, /u);

    const worktree = transfer.remote!.path;
    expect(worktree).toBe(join(hosts.rexRoot, "worktrees", "work", "tidy-the-readme"));
    expect(transfer.remote!.branch).toBe("tau/mini/tidy-the-readme");
    expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("# Fixture\n\nAn uncommitted line.\n");
    expect(await readFile(join(worktree, "notes/draft.md"), "utf8")).toBe("An untracked draft.\n");
    expect(await readFile(join(worktree, ".env"), "utf8")).toBe("SECRET=local\n");
    expect(await readFile(join(worktree, ".scratch/issues/01.md"), "utf8")).toBe("# Issue\n");
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
    expect(hosts.rexGit(worktree, "rev-parse", "HEAD")).toBe(transfer.base);
    expect(hosts.rexGit(worktree, "config", `branch.${transfer.remote!.branch}.tau-base`)).toBe(transfer.base);
    expect(hosts.rexGit(worktree, "status", "--porcelain", "--ignored=no")).toBe("");
    expect(existsSync(hosts.hookMark)).toBe(false);
    // Nothing here changed: the user's index and files are as they were, and no branch was added.
    expect(repo.git("status", "--porcelain")).toBe("M README.md\n?? notes/");
    expect(repo.git("branch", "--list")).toBe("* main");
    expect(repo.git("rev-parse", `refs/tau/transfer/${transfer.id}`)).toBe(transfer.base);
    expect(hosts.aEvents.filter((event) => event.name === TRANSFER_EVENT).at(-1)?.payload).toMatchObject({ id: transfer.id, state: "ready" });
  });

  it("brings the work back as tau/rex/<slug> and merges it; a second run with a conflict leaves the checkout untouched", async () => {
    const { repo, call, rexGit } = await twoHosts();
    const first = await call<RepoTransfer>("send", { machine: "rex", cwd: repo.work, name: "Tidy the readme" });
    const there = first.remote!.path;
    // The work there: a committed change, and one left uncommitted.
    await put(there, "src/app.js", "export const greeting = \"hello, rex\";\nexport const farewell = \"bye\";\n");
    rexGit(there, "-c", "user.name=Rex", "-c", "user.email=rex@example.invalid", "commit", "-qam", "greet from rex");
    await put(there, "CHANGELOG.md", "- greeting\n");

    const back = await call<RepoTransfer>("fetch-result", { transfer: first.id });
    expect(back.result).toMatchObject({ state: "branch", branch: "tau/rex/tidy-the-readme", commits: 2, files: 2, paths: ["CHANGELOG.md", "src/app.js"] });
    expect(repo.git("config", "branch.tau/rex/tidy-the-readme.tau-base")).toBe(first.base);
    expect(repo.git("log", "-1", "--format=%s", "tau/rex/tidy-the-readme")).toBe("tau: result");
    expect(await call<TransferPreview>("preview", { transfer: first.id })).toMatchObject({ clean: true, conflicts: [], merged: false });

    const applied = await call<RepoTransfer>("apply", { transfer: first.id });
    expect(applied.applied).toMatchObject({ state: "merged" });
    // The uncommitted work that went along is in the merge now; nothing is left over.
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(repo.git("rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(await readFile(join(repo.work, "src/app.js"), "utf8")).toContain("hello, rex");
    expect(await readFile(join(repo.work, "README.md"), "utf8")).toContain("An uncommitted line.");
    expect(await readFile(join(repo.work, "CHANGELOG.md"), "utf8")).toBe("- greeting\n");

    // Second run: both sides change the same line.
    const second = await call<RepoTransfer>("send", { machine: "rex", cwd: repo.work, name: "Tidy the readme" });
    await put(second.remote!.path, "src/app.js", "export const greeting = \"rex wins\";\nexport const farewell = \"bye\";\n");
    await put(repo.work, "src/app.js", "export const greeting = \"here wins\";\nexport const farewell = \"bye\";\n");
    repo.git("commit", "-qam", "greet from here");
    const head = repo.git("rev-parse", "HEAD");
    const conflicted = await call<RepoTransfer>("fetch-result", { transfer: second.id });
    expect(conflicted.result).toMatchObject({ state: "branch", branch: "tau/rex/tidy-the-readme-2" });
    expect(await call<TransferPreview>("preview", { transfer: second.id })).toMatchObject({ clean: false, conflicts: ["src/app.js"] });
    const refused = await call<RepoTransfer>("apply", { transfer: second.id });
    expect(refused.applied).toMatchObject({ state: "conflict", files: ["src/app.js"] });
    expect(repo.git("rev-parse", "HEAD")).toBe(head);
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(repo.git("rev-parse", "--verify", "tau/rex/tidy-the-readme-2")).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("names the worktree there after the project and the work, and rex's rail after the project, also after a restart", async () => {
    const hosts = await twoHosts();
    const first = await hosts.call<RepoTransfer>("send", { machine: "rex", cwd: hosts.repo.work, name: "Tidy the readme" });
    const second = await hosts.call<RepoTransfer>("send", { machine: "rex", cwd: hosts.repo.work, name: "Tidy the readme" });
    const unnamed = await hosts.call<RepoTransfer>("send", { machine: "rex", cwd: hosts.repo.work });
    const folder = join(hosts.rexRoot, "worktrees", "work");
    expect([first, second, unnamed].map((transfer) => [transfer.remote!.path, transfer.remote!.branch])).toEqual([
      [join(folder, "tidy-the-readme"), "tau/mini/tidy-the-readme"],
      [join(folder, "tidy-the-readme-2"), "tau/mini/tidy-the-readme-2"],
      [join(folder, unnamed.id), `tau/mini/${unnamed.id}`],
    ]);
    // Git would name a worktree of the bare mirror after the mirror's folder ("repos").
    expect([...hosts.projectNames.entries()]).toEqual([first, second, unnamed].map((transfer) => [transfer.remote!.path, "work"]));

    const restarted = new Map<string, string>();
    await activateHostKit(createRemoteWorkHostExtension({ root: hosts.rexRoot, env: hosts.rexEnv }), {
      ...hosts.rexServices,
      rememberProjectName: (path: string, name: string) => { restarted.set(path, name); },
    });
    expect(restarted).toEqual(hosts.projectNames);
  });

  it("answers nothing when nothing changed there, and leaves out the bundle when rex has every commit", async () => {
    const { repo, call } = await twoHosts();
    repo.git("add", "-A");
    repo.git("commit", "-qm", "commit the work here");
    repo.git("push", "-q", "origin", "main");
    const transfer = await call<RepoTransfer>("send", { machine: "rex", cwd: repo.work });
    expect(transfer.base).toBe(repo.git("rev-parse", "HEAD"));
    expect(transfer.steps.find((step) => step.id === "bundle")).toMatchObject({ state: "skipped", detail: "rex has every commit already" });
    expect(transfer.steps.find((step) => step.id === "upload")?.state).toBe("skipped");
    expect((await call<RepoTransfer>("fetch-result", { transfer: transfer.id })).result).toMatchObject({ state: "nothing" });
  });

  it("starts an empty mirror when rex cannot read origin, and sends every commit", async () => {
    const hosts = await twoHosts();
    hosts.repo.git("remote", "set-url", "origin", "https://example.invalid/nobody/fixture.git");
    const transfer = await hosts.call<RepoTransfer>("send", { machine: "rex", cwd: hosts.repo.work });
    expect(transfer.steps.find((step) => step.id === "mirror")?.detail).toMatch(/not readable from here/u);
    expect(transfer.steps.find((step) => step.id === "bundle")?.detail).toMatch(/^3 commits, /u);
    expect(hosts.rexGit(transfer.remote!.path, "rev-list", "--count", "HEAD")).toBe("3");
  });

  it("runs the project's setup scripts in the new worktree through Project Scripts", async () => {
    const hosts = await twoHosts({
      projectScripts: true,
      projectFile: { scripts: [{ name: "Install", command: "printf ok > installed.txt", runOnWorktreeCreate: true, async: false }] },
    });
    const transfer = await hosts.call<RepoTransfer>("send", { machine: "rex", cwd: hosts.repo.work });
    expect(transfer.steps.find((step) => step.id === "setup")).toMatchObject({ state: "done", detail: "Install: succeeded" });
    expect(await readFile(join(transfer.remote!.path, "installed.txt"), "utf8")).toBe("ok");
  });

  it("runs the old runOnWorktreeCreate line itself without Project Scripts, and a failing one is reported, not undone", async () => {
    const good = await twoHosts({ projectFile: { runOnWorktreeCreate: "printf ok > set-up.txt" } });
    const transfer = await good.call<RepoTransfer>("send", { machine: "rex", cwd: good.repo.work });
    expect(transfer.steps.find((step) => step.id === "setup")).toMatchObject({ state: "done" });
    expect(await readFile(join(transfer.remote!.path, "set-up.txt"), "utf8")).toBe("ok");

    const bad = await twoHosts({ projectFile: { runOnWorktreeCreate: "exit 3" } });
    const failed = await bad.call<RepoTransfer>("send", { machine: "rex", cwd: bad.repo.work });
    expect(failed.state).toBe("ready");
    expect(failed.steps.find((step) => step.id === "setup")).toMatchObject({ state: "failed", detail: "exit 3: exit 3" });
  });

  it("lets a transfer go: the worktree and branch there, the transfer ref here", async () => {
    const { repo, call, rexRoot } = await twoHosts();
    const transfer = await call<RepoTransfer>("send", { machine: "rex", cwd: repo.work });
    expect(existsSync(transfer.remote!.path)).toBe(true);
    const gone = await call<RepoTransfer>("discard", { transfer: transfer.id });
    expect(gone.state).toBe("discarded");
    expect(existsSync(transfer.remote!.path)).toBe(false);
    expect(() => repo.git("rev-parse", "--verify", `refs/tau/transfer/${transfer.id}`)).toThrow();
    const mirror = join(rexRoot, "repos", `${transfer.repo.key}.git`);
    expect(execFileSync("git", ["branch", "--list", "tau/mini/*"], { cwd: mirror }).toString().trim()).toBe("");
    await expect(call("fetch-result", { transfer: transfer.id })).rejects.toThrow(/no worktree there/u);
  });

  it("refuses a machine without git or space, and records the failed step", async () => {
    const noGit = await twoHosts({ readiness: { ...READY, git: { mergeTree: false } } });
    await expect(noGit.call("send", { machine: "rex", cwd: noGit.repo.work })).rejects.toThrow(/rex has no git/u);
    const [failed] = await noGit.call<RepoTransfer[]>("transfers", { cwd: noGit.repo.work });
    expect(failed).toMatchObject({ state: "failed", error: expect.stringMatching(/no git/u) });
    expect(failed.steps.find((step) => step.id === "check")?.state).toBe("failed");

    const full = await twoHosts({ readiness: { ...READY, disk: { path: "/", free: 10 * 1024 * 1024 } } });
    await expect(full.call("send", { machine: "rex", cwd: full.repo.work })).rejects.toThrow(/only 10\.0 MB free/u);
  });

  it("keeps each device to its own transfers there, and turns away another protocol", async () => {
    const hosts = await twoHosts();
    const transfer = await hosts.call<RepoTransfer>("send", { machine: "rex", cwd: hosts.repo.work });
    const other = { kind: "workbench-client" as const, connection: "c2", pairedClient: "someone-else" };
    await expect(hosts.rex.invoke(ID, "worktree-result", { protocol: 1, transfer: transfer.id }, other)).rejects.toThrow(/no worktree for transfer/u);
    await expect(hosts.rex.invoke(ID, "worktree-remove", { transfer: transfer.id }, other)).rejects.toThrow(/no worktree for transfer/u);
    await expect(hosts.rex.invoke(ID, "mirror-prepare", { protocol: 99, transfer: transfer.id, repo: transfer.repo }, hosts.paired)).rejects.toThrow(/protocol 1, the caller 99/u);
    await expect(hosts.rex.invoke(ID, "mirror-prepare", { protocol: 1, transfer: transfer.id, repo: { ...transfer.repo, key: "../escape" } }, hosts.paired)).rejects.toThrow(/not a project key/u);
  });

  it("refuses a project without a commit", async () => {
    const hosts = await twoHosts();
    const empty = join(hosts.dir, "empty");
    await mkdir(empty);
    execFileSync("git", ["init", "-q"], { cwd: empty });
    await expect(hosts.call("send", { machine: "rex", cwd: empty })).rejects.toThrow(/no commit yet/u);
  });
});
