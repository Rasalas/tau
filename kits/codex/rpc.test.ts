import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { RpcConnection, type RpcClosedError, type RpcProcess } from "./rpc.js";

function fakeProcess(oomKilled?: () => Promise<boolean>) {
  let exit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { exit = resolve; });
  const process: RpcProcess = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true, exited, ...(oomKilled ? { oomKilled } : {}) };
  return { process, exit };
}

const connections: RpcConnection[] = [];

function connect(process: RpcProcess) {
  const closed = new Promise<RpcClosedError | undefined>((resolve) => {
    connections.push(new RpcConnection({ process, onNotification: () => undefined, onRequest: async () => ({}), onExit: resolve }));
  });
  return closed;
}

describe("a Codex process that exits", () => {
  it("says it was killed for memory when its scope recorded that", async () => {
    const { process, exit } = fakeProcess(async () => true);
    const closed = connect(process);
    exit({ code: null, signal: "SIGKILL" });
    expect((await closed)?.message).toBe("Killed: out of memory.");
  });

  it("keeps the exit code and stderr when memory was not the reason", async () => {
    const { process, exit } = fakeProcess(async () => false);
    const closed = connect(process);
    (process.stderr as PassThrough).write("stub: gone\n");
    await new Promise((resolve) => setImmediate(resolve));
    exit({ code: 3, signal: null });
    expect((await closed)?.message).toBe("Codex exited with code 3.\nstub: gone");
  });

  it("keeps the plain message when the scope cannot be read", async () => {
    const { process, exit } = fakeProcess(() => Promise.reject(new Error("no bus")));
    const closed = connect(process);
    exit({ code: 1, signal: null });
    expect((await closed)?.message).toBe("Codex exited with code 1.");
  });

  it("does not ask about a clean exit", async () => {
    let asked = false;
    const { process, exit } = fakeProcess(async () => { asked = true; return true; });
    const closed = connect(process);
    exit({ code: 0, signal: null });
    expect((await closed)?.message).toBe("Codex exited with code 0.");
    expect(asked).toBe(false);
  });
});
