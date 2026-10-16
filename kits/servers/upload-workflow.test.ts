import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { HostExtensionContext, HostExtensionServices } from "tau/host-extension";
import { ConnectionConsent } from "./connection-consent.js";
import { ServerFolders } from "./folders.js";
import { FolderServerFs } from "./fixtures/fake-server-fs.js";
import { ServerPrompts } from "./prompts.js";
import { ServersStore } from "./store.js";
import { SyncService } from "./sync/service.js";
import { ServerTargets } from "./targets.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "tau-upload-workflow-")); roots.push(dir);
  const local = join(dir, "local"); const server = join(dir, "server");
  await mkdir(join(local, ".vscode"), { recursive: true }); await mkdir(server);
  const config = { name: "site", protocol: "sftp", host: "127.0.0.1", port: 2222, username: "test", remotePath: "/" };
  const configPath = join(local, ".vscode/sftp.json"); await writeFile(configPath, JSON.stringify(config));
  const services = { knownWorkspacePath: async (path: string) => path, workspaceRef: () => ({ workspaceId: "ws", displayPath: local }), log: () => undefined } as unknown as HostExtensionServices;
  const context = { services, emit: () => undefined } as unknown as HostExtensionContext;
  const store = new ServersStore(join(dir, "state"), { warn: () => undefined });
  const targets = new ServerTargets({ services, store });
  const target = (await targets.list(local)).targets[0]!;
  const fs = new FolderServerFs(server, { writable: true });
  const prompts = new ServerPrompts(() => undefined, () => true);
  const connect = vi.fn(async () => fs);
  const sync = new SyncService(context, { store, target: (cwd, id) => targets.target(cwd, id), transport: connect, withSignal: (signal, run) => prompts.withSignal(signal, run) });
  const folders = new ServerFolders(store, sync);
  return { dir, local, server, config, configPath, target, targets, store, fs, sync, folders, prompts, connect, ref: { cwd: local, targetId: target.id } };
}

it("warns after one directory listing and never reads unrelated server contents", async () => {
  const w = await setup();
  await writeFile(join(w.local, "index.php"), "local");
  await mkdir(join(w.server, "other-site")); await writeFile(join(w.server, "other-site/secret.php"), "private");
  const match = await w.sync.exclusive(w.ref, (session) => w.folders.check(session));
  expect(match?.weak).toBe(true);
  expect(w.fs.calls).toEqual(["list "]);
  await w.sync.exclusive(w.ref, (session) => w.folders.confirm(session));
  w.fs.calls.length = 0;
  expect(await w.sync.exclusive(w.ref, (session) => w.folders.check(session))).toBeUndefined();
  expect(w.fs.calls).toEqual([]);
});

it("isolates folder and destination changes while retaining a server's state across branches", async () => {
  const w = await setup();
  const first = w.target.id;
  await w.targets.setFolders({ ...w.ref, remotePath: "/httpdocs", context: "" });
  const mapped = (await w.targets.list(w.local)).targets[0]!;
  expect(mapped.id).not.toBe(first);
  expect(mapped.remotePath).toBe("/httpdocs");
  expect(JSON.parse(await readFile(w.configPath, "utf8")).remotePath).toBe("/");
  expect((await w.targets.list(w.local)).targets[0]!.id).toBe(mapped.id);
  await w.targets.setFolders({ cwd: w.local, targetId: mapped.id, remotePath: "/", context: "" });
  expect((await w.targets.list(w.local)).targets[0]!.id).toBe(first);
  await writeFile(w.configPath, JSON.stringify({ ...w.config, host: "another.example.invalid" }));
  const changed = (await w.targets.list(w.local)).targets[0]!;
  expect(changed.id).not.toBe(first);
  expect(changed.remotePath).toBe("/");
  expect(w.connect).not.toHaveBeenCalled();
});

it("remembers connection approval across instances and ignores display and performance changes", async () => {
  const w = await setup();
  let saved: string | undefined;
  const grants = { read: async () => saved, write: async (_cwd: string, _target: unknown, fingerprint: string) => { saved = fingerprint; } };
  const ask = vi.fn(async () => ({ action: "confirm" as const }));
  await new ConnectionConsent({ ask }, grants).approve(w.local, w.target);
  expect(ask).toHaveBeenCalledOnce();
  const next = new ConnectionConsent({ ask }, grants);
  await next.approve(w.local, { ...w.target, name: "Renamed", concurrency: 2, ignore: ["logs"] });
  expect(ask).toHaveBeenCalledOnce();
  await next.approve(w.local, { ...w.target, remotePath: "/other" });
  expect(ask).toHaveBeenCalledTimes(2);
});

it("cancels a pending login and releases the target queue for the next action", async () => {
  const w = await setup();
  w.connect.mockImplementationOnce(async () => {
    await w.prompts.ask({ kind: "secret", title: "Password", message: "Test server", confirmLabel: "Connect" });
    throw new Error("Cancelled login");
  });
  const running = w.sync.exclusive({ ...w.ref, operationId: "login" }, (session) => session.connect());
  const rejected = expect(running).rejects.toThrow(/stopped/u);
  await vi.waitFor(() => expect(w.prompts.pending()).toHaveLength(1));
  w.sync.cancel({ ...w.ref, operationId: "login" });
  await rejected;
  expect(w.prompts.pending()).toEqual([]);
  expect(await w.sync.exclusive(w.ref, (session) => session.connect())).toBe(w.fs);
});


it("bounds an explicit folder search and never downloads file contents", async () => {
  const w = await setup();
  await writeFile(join(w.local, "index.php"), "local");
  await Promise.all(Array.from({ length: 70 }, async (_, index) => {
    const dir = join(w.server, `site-${String(index).padStart(2, "0")}`);
    await mkdir(dir); await writeFile(join(dir, "index.php"), "private server data");
  }));
  const commands = new Map<string, (raw: unknown) => unknown>();
  w.folders.register({ registerCommand: (name: string, run: (raw: unknown) => unknown) => { commands.set(name, run); } } as unknown as HostExtensionContext);
  const result = await commands.get("find-server-folder")!(w.ref) as { opened: number; limited: boolean };
  expect(result).toMatchObject({ opened: 64, limited: true });
  expect(w.fs.calls).toHaveLength(64);
  expect(w.fs.calls.every((call) => call.startsWith("list "))).toBe(true);
});
