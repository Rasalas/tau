import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionServices, HostMcpToolProvider, HostTurnObserver } from "tau/host-extension";
import { BackgroundCommands, registerBackgroundCommands } from "./background-commands.js";

const managers: BackgroundCommands[] = [];
const folders: string[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((work) => work.dispose())); await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
const quote = (text: string) => `'${text.replace(/'/gu, `'\\''`)}'`;
const node = (source: string) => `${quote(process.execPath)} -e ${quote(source)}`;
async function workspace() { const folder = await mkdtemp(join(tmpdir(), "tau-background-")); folders.push(folder); return folder; }
function manager() { const changed = vi.fn(); const ended = vi.fn(); const work = new BackgroundCommands(changed, ended); managers.push(work); return { work, ended, changed }; }

describe("tracked background commands", () => {
  it("holds a real result until a successful later turn handles it, and never clears a newer result", async () => {
    const { work, ended } = manager();
    const cwd = await workspace();
    const before = work.snapshot("thread");
    const id = await work.start("thread", cwd, node('process.stdout.write("passed")'), "Tests");
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1), { timeout: 20_000 });
    expect(work.capability("thread").current()).toEqual([expect.objectContaining({ id, state: "reported" })]);
    expect(work.capability("thread").read!(id)).toEqual({ output: "passed", exitCode: 0 });
    work.handled("thread", before);
    expect(work.capability("thread").current()).toHaveLength(1);
    work.handled("thread", work.snapshot("thread"));
    expect(work.capability("thread").current()).toEqual([]);
  });

  it("keeps a failed command and its output available as an unhandled result", async () => {
    const { work, ended } = manager();
    const id = await work.start("thread", await workspace(), node('process.stderr.write("test failed");process.exit(3)'), "Tests");
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1), { timeout: 20_000 });
    expect(work.capability("thread").read!(id)).toEqual({ output: "test failed", exitCode: 3 });
    expect(work.capability("thread").current()[0]?.state).toBe("reported");
    expect(() => work.capability("thread").release!(id)).toThrow("no longer running");
  });

  it("releases a checked service while it keeps running, then stops its process without waking the agent", async () => {
    const { work, ended } = manager();
    const id = await work.start("thread", await workspace(), node('process.stdout.write("ready");setInterval(()=>{},1000)'), "Devserver");
    await vi.waitFor(() => expect(work.capability("thread").read!(id).output).toBe("ready"), { timeout: 20_000 });
    work.capability("thread").release!(id);
    expect(work.capability("thread").current()[0]?.blocksCompletion).toBe(false);
    await work.capability("thread").stop(id);
    expect(work.capability("thread").current()).toEqual([]);
    expect(ended).not.toHaveBeenCalled();
  });

  it("stops the command's descendants too and isolates tasks by thread", async () => {
    const { work, ended } = manager();
    const cwd = await workspace();
    const pidFile = join(cwd, "child-pid");
    const source = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000)`;
    const id = await work.start("one", cwd, node(source), "Parent and child");
    let childPid = 0;
    await vi.waitFor(async () => { childPid = Number(await readFile(pidFile, "utf8")); expect(childPid).toBeGreaterThan(0); }, { timeout: 20_000 });
    expect(work.capability("two").current()).toEqual([]);
    await expect(work.capability("two").stop(id)).rejects.toThrow("no longer available");
    await work.capability("one").stop(id);
    // A killed descendant may briefly be a zombie until the OS reaps it.
    await vi.waitFor(async () => {
      try {
        process.kill(childPid, 0);
        if (process.platform !== "linux") throw new Error("The descendant is still running.");
        const stat = await readFile(`/proc/${childPid}/stat`, "utf8");
        expect(stat.split(") ")[1]?.[0]).toBe("Z");
      } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    });
    expect(ended).not.toHaveBeenCalled();
  });

  it("labels a requested watch as Monitoring and never releases it as a service", async () => {
    const { work } = manager();
    const id = await work.start("thread", await workspace(), node('setInterval(()=>{},1000)'), "Watch CI", undefined, "monitor");
    expect(work.capability("thread").current()[0]?.kind).toBe("monitor");
    expect(() => work.capability("thread").release!(id)).toThrow("Only a checked command");
  });

  it("refuses an aborted start and removes a command which could not start", async () => {
    const { work, ended } = manager();
    await expect(work.start("thread", "/missing/tau-background-work", "exit 0", "Failed start")).rejects.toThrow();
    await expect(work.start("thread", await workspace(), "exit 0", "Cancelled", AbortSignal.abort())).rejects.toThrow("cancelled");
    expect(work.capability("thread").current()).toEqual([]);
    expect(ended).not.toHaveBeenCalled();
  });
});

it("refuses a network-limited command before spawning and registers Pi and MCP against the same manager", async () => {
  let provider!: HostMcpToolProvider;
  let observer!: HostTurnObserver;
  const noteSubprocess = vi.fn();
  const registerPi = vi.fn();
  const dispose = registerBackgroundCommands({
    background: { provide: () => () => undefined, changed: () => undefined },
    thread: () => ({ sessionId: "thread", cwd: "/repo" }),
    executionPolicy: { for: async () => ({ network: "loopback", allowHosts: [], reasons: ["Limited network"], sources: [] }) },
    sessions: { send: async () => undefined },
    noteSubprocess,
    mcp: { registerTools: (value: HostMcpToolProvider) => { provider = value; return () => undefined; } },
    registerRuntimeExtension: registerPi.mockReturnValue(() => undefined),
    registerTurnObserver: (value: HostTurnObserver) => { observer = value; return () => undefined; },
    registerThreadLifecycle: () => () => undefined,
  } as unknown as HostExtensionServices);
  try {
    const [tool] = await provider({ sessionId: "thread", cwd: "/repo" });
    await expect(tool!.execute("call", { command: "curl example.com", label: "Fetch" }, undefined, undefined, undefined as never)).rejects.toThrow("cannot enforce");
    expect(noteSubprocess).not.toHaveBeenCalled();
    expect(registerPi).toHaveBeenCalledWith("tau-background-command", expect.any(Function));
    expect(observer.prepare).toBeTypeOf("function");
  } finally { await dispose(); }
});
