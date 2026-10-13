import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { RpcClosedError, RpcConnection, spawnRpcProcess } from "./rpc.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("tau/host-extension", () => ({
  AGENT_OOM_MESSAGE: "Killed: out of memory.",
  commandInvocation: (command: string, args: string[]) => ({ command, args }),
  wrapAgentCommand: (input: unknown) => input,
  spawnOwnedProcess: spawn,
}));

afterEach(() => vi.useRealTimers());

it("finishes forced shutdown on exit even when an inherited pipe never closes", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn((signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") child.emit("exit", null, signal);
      return true;
    }),
  });
  spawn.mockReturnValue(child);
  const process = spawnRpcProcess({ command: "fixture", args: [], cwd: "/repo", env: {} });
  const onExit = vi.fn();
  const connection = new RpcConnection({ process, onNotification: () => undefined, onRequest: async () => ({}), onExit });
  const pending = connection.request("thread/start", {}).catch((error: unknown) => error);
  let closed = false;
  const close = connection.close().then(() => { closed = true; });
  await vi.advanceTimersByTimeAsync(1_999);
  expect(closed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(closed).toBe(true);
  await close;
  expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  expect(await pending).toBeInstanceOf(RpcClosedError);
  expect(onExit).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(child.stdout.destroyed).toBe(true);
  expect(child.stderr.destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("drains stderr for an ordinary exit before reporting it", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  spawn.mockReturnValue(child);
  const process = spawnRpcProcess({ command: "fixture", args: [], cwd: "/repo", env: {} });
  const onExit = vi.fn();
  let connection!: RpcConnection;
  const reported = new Promise<void>((resolve) => {
    connection = new RpcConnection({ process, onNotification: () => undefined, onRequest: async () => ({}), onExit: (error) => { onExit(error); resolve(); } });
  });
  child.emit("exit", 3, null);
  await Promise.resolve();
  expect(onExit).not.toHaveBeenCalled();
  child.stderr.write("last diagnostic\n");
  child.emit("close", 3, null);
  await reported;
  expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("with code 3.\nlast diagnostic") }));
  expect(connection.closed).toBe(true);
});
