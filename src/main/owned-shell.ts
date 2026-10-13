import { constants } from "node:os";
import { access } from "node:fs/promises";
import { createBashToolDefinition, getShellConfig, type BashOperations, type ExtensionFactory, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { spawnOwnedShellProcess } from "./owned-process.js";

/** Keeps the tool formatting; only process ownership changes. */
export function ownedBashOperations(settings: Pick<SettingsManager, "getShellPath">): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (signal?.aborted) throw new Error("aborted");
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1_000 > 2_147_483_647)) throw new Error("Invalid shell timeout");
      await access(cwd);
      const shell = getShellConfig(settings.getShellPath());
      const fromStdin = shell.commandTransport === "stdin";
      const { child, exited } = spawnOwnedShellProcess({
        command: shell.shell,
        args: fromStdin ? shell.args : [...shell.args, command],
        cwd,
        env: env ?? process.env,
      });
      const abort = () => { child.kill("SIGTERM"); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.stdin.on("error", () => undefined);
      child.stdin.end(fromStdin ? command : undefined);
      let timedOut = false;
      const timer = timeout === undefined ? undefined : setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout * 1_000);
      try {
        const result = await exited;
        // A background child can hold the pipes open after its shell exits.
        await new Promise<void>((resolve) => {
          let idle = setTimeout(done, 100);
          const received = () => { clearTimeout(idle); idle = setTimeout(done, 100); };
          function done() {
            child.stdout.removeListener("data", received);
            child.stderr.removeListener("data", received);
            resolve();
          }
          child.stdout.on("data", received);
          child.stderr.on("data", received);
        });
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode: result.code ?? (result.signal ? 128 + (constants.signals[result.signal] ?? 0) : 1) };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        child.stdout.removeListener("data", onData);
        child.stderr.removeListener("data", onData);
      }
    },
  };
}

export function ownedShellExtension(cwd: string, settings: SettingsManager): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      ...createBashToolDefinition(cwd, {
        operations: ownedBashOperations(settings),
        spawnHook: (input) => {
          const prefix = settings.getShellCommandPrefix();
          return { ...input, command: prefix ? `${prefix}\n${input.command}` : input.command };
        },
      }),
      // Retain the built-in tool's initial selection from defaultTools.
      defaultActive: false,
    });
  };
}
