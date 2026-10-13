import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { SessionStorePersistence } from "./session-store-persistence.js";

it("merges independent process snapshots under the shared file's lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-session-writers-"));
  const filePath = join(directory, "sessions.json");
  const bundle = join(directory, "persistence.cjs");
  const children: ReturnType<typeof start>[] = [];
  function start(prefix: string) {
    const child = spawn(process.execPath, ["-e", `
      const { SessionStorePersistence } = require(process.argv[1]);
      const store = new SessionStorePersistence({ filePath: process.argv[2], version: 1, decode: value => value });
      const sessions = [];
      (async () => {
        await store.load();
        process.once('message', async () => {
          try {
            for (let i = 0; i < 10; i++) {
              sessions.push({ tauThreadId: process.argv[3] + i });
              await store.write({ sessions });
            }
          } catch (error) {
            console.error(error);
            process.exitCode = 1;
          } finally {
            process.disconnect();
          }
        });
        process.send('ready');
      })().catch(error => { console.error(error); process.exit(1); });
    `, bundle, filePath, prefix], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let errors = "";
    child.stderr!.on("data", (data) => { errors += String(data); });
    const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
    const ready = new Promise<void>((done, fail) => {
      child.once("message", () => done());
      child.once("error", fail);
      child.once("exit", () => fail(new Error(errors || "Writer exited before ready")));
    });
    return { child, exited, ready, errors: () => errors };
  }
  try {
    await build({
      entryPoints: [fileURLToPath(new URL("./session-store-persistence.ts", import.meta.url))],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      alias: { "tau/host-extension": resolve("src/main/host-extension-api.ts") },
    });
    children.push(start("first-"), start("second-"));
    await Promise.all(children.map((writer) => writer.ready));
    for (const writer of children) writer.child.send("write");
    const codes = await Promise.all(children.map((writer) => writer.exited));
    expect(codes, children.map((writer) => writer.errors()).join("\n")).toEqual([0, 0]);
    const reloaded = new SessionStorePersistence<{ tauThreadId: string }>({ filePath, version: 1, decode: (value) => value as { sessions: Array<{ tauThreadId: string }> } });
    expect((await reloaded.load())?.sessions.map((record) => record.tauThreadId).sort()).toEqual(
      ["first-", "second-"].flatMap((prefix) => Array.from({ length: 10 }, (_, i) => `${prefix}${i}`)),
    );
  } finally {
    for (const writer of children) if (writer.child.exitCode === null && writer.child.signalCode === null) writer.child.kill();
    await Promise.all(children.map((writer) => writer.exited));
    await rm(directory, { recursive: true, force: true });
  }
});
