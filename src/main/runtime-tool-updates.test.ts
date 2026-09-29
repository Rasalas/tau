import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliCommand, RuntimeToolMaintenance } from "./cli-install.js";
import type { HostRuntimeBackendProvider } from "./host-extensions.js";
import { RuntimeToolUpdates, runToolCommand, type RuntimeToolRun, type RuntimeToolUpdatesOptions } from "./runtime-tool-updates.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const BREW = "/opt/homebrew/bin/brew";
const NPM = "/opt/homebrew/bin/npm";

function codex(installed: () => string, overrides: Partial<RuntimeToolMaintenance> = {}): RuntimeToolMaintenance {
  return {
    tool: "codex",
    installed: installed(),
    latest: "0.159.1",
    install: { method: "npm", label: "npm in ~/.local", path: "/u/.local/bin/codex", realPath: "/u/.local/lib/node_modules/@openai/codex/bin/codex.js" },
    update: { executable: NPM, args: ["install", "-g", "--prefix", "/u/.local", "@openai/codex@latest"] },
    ...overrides,
  };
}

function provider(kind: string, label: string, maintenance: () => RuntimeToolMaintenance | undefined): HostRuntimeBackendProvider {
  return { kind, label, maintenance: async () => maintenance() } as unknown as HostRuntimeBackendProvider;
}

function harness(providers: HostRuntimeBackendProvider[], options: Partial<RuntimeToolUpdatesOptions> & { exit?: (command: CliCommand) => number } = {}) {
  const ran: string[] = [];
  const rechecked: string[] = [];
  const busy = new Set<string>();
  let changes = 0;
  const run = vi.fn(async (command: CliCommand): Promise<RuntimeToolRun> => {
    ran.push([command.executable.split("/").pop(), ...command.args].join(" "));
    return { exitCode: options.exit?.(command) ?? 0, output: "done" };
  });
  const updates = new RuntimeToolUpdates({
    backends: () => providers,
    busy: () => busy,
    recheck: async (kind) => { rechecked.push(kind); },
    changed: () => { changes += 1; },
    env: {},
    log: () => undefined,
    run,
    now: () => 5_000,
    startDelayMs: 60_000,
    ...options,
  });
  return { updates, ran, rechecked, busy, changes: () => changes };
}

describe("RuntimeToolUpdates", () => {
  it("asks once, then keeps a program current and has every runtime that drives it asked again", async () => {
    let version = "0.159.0";
    const ran: string[] = [];
    const { updates, rechecked } = harness([
      provider("codex", "Codex", () => codex(() => version)),
      provider("codex@work", "Codex (work)", () => codex(() => version)),
    ], { run: async (command) => { ran.push(command.args.join(" ")); version = "0.159.1"; return { exitCode: 0, output: "added 1 package" }; } });
    expect(updates.updatesFor("codex")).toBeUndefined();
    await updates.ensure("codex");
    expect(updates.updatesFor("codex")).toBe("ask");
    let state = await updates.state();
    expect(state.automatic).toBeUndefined();
    expect(state.tools).toMatchObject([{ kinds: ["codex", "codex@work"], label: "Codex", installed: "0.159.0", latest: "0.159.1", source: "npm in ~/.local", update: "npm install -g --prefix /u/.local @openai/codex@latest" }]);
    state = await updates.setAutomatic(true);
    expect(updates.updatesFor("codex@work")).toBe("automatic");
    await vi.waitFor(async () => expect((await updates.state()).log[0]).toMatchObject({ label: "Codex", action: "update", from: "0.159.0", to: "0.159.1", outcome: "ok" }));
    expect(ran).toEqual(["install -g --prefix /u/.local @openai/codex@latest"]);
    expect(rechecked.sort()).toEqual(["codex", "codex@work"]);
  });

  it("waits while a turn of the runtime runs and updates once it ended", async () => {
    let version = "0.159.0";
    const ran: string[] = [];
    const { updates, busy } = harness([provider("codex", "Codex", () => codex(() => version))], {
      run: async (command) => { ran.push(command.args[0]!); version = "0.159.1"; return { exitCode: 0, output: "" }; },
    });
    busy.add("codex");
    const state = await updates.update("codex");
    expect(state.tools[0]?.state).toBe("waiting");
    expect((await updates.state()).log[0]).toMatchObject({ outcome: "waiting" });
    expect(ran).toEqual([]);
    busy.clear();
    updates.turnEnded();
    await vi.waitFor(async () => expect((await updates.state()).log[0]).toMatchObject({ outcome: "ok", to: "0.159.1" }));
    expect(ran).toEqual(["install"]);
  });

  it("shows a failed update with its output and leaves the version", async () => {
    const { updates } = harness([provider("codex", "Codex", () => codex(() => "0.159.0"))], { exit: () => 1 });
    await updates.update("codex");
    await vi.waitFor(async () => expect((await updates.state()).log[0]).toMatchObject({ outcome: "failed", message: "Exited with 1; 0.159.0 stays.", output: "done" }));
  });

  it("runs nothing in a test instance, and offers nothing", async () => {
    const { updates, ran } = harness([provider("codex", "Codex", () => codex(() => "0.159.0"))], { env: { TAU_RUNTIME_UPDATE_COMMAND: "{\"*\":\"echo\"}" } });
    const state = await updates.setAutomatic(true);
    expect(state.blocked).toContain("TAU_RUNTIME_UPDATE_COMMAND");
    expect(updates.updatesFor("codex")).toBeUndefined();
    await expect(updates.update("codex")).rejects.toThrow("runs no updates");
    expect(ran).toEqual([]);
  });

  it("switches from a lagging Homebrew to npm only when asked, and puts Homebrew back when npm fails", async () => {
    const lagging = () => codex(() => "0.159.0", {
      latest: "0.159.0",
      install: { method: "homebrew-cask", label: "Homebrew cask codex", path: "/opt/homebrew/bin/codex", realPath: "/opt/homebrew/Caskroom/codex/0.159.0/codex" },
      update: { executable: BREW, args: ["upgrade", "--cask", "codex"] },
      behind: { source: "homebrew", latest: "0.159.0", newer: { source: "npm", latest: "0.159.1" } },
      switch: {
        steps: [{ executable: BREW, args: ["uninstall", "--cask", "codex"] }, { executable: NPM, args: ["install", "-g", "@openai/codex@latest"] }],
        restore: [{ executable: BREW, args: ["install", "--cask", "codex"] }],
      },
    });
    const { updates, ran } = harness([provider("codex", "Codex", lagging)], { exit: (command) => command.executable === NPM ? 1 : 0 });
    const automatic = await updates.setAutomatic(true);
    expect(automatic.tools[0]).toMatchObject({ behind: { latest: "0.159.0", newer: { latest: "0.159.1" } }, switchSteps: ["brew uninstall --cask codex", "npm install -g @openai/codex@latest"] });
    expect(ran).toEqual([]);
    await updates.switchSource("codex");
    await vi.waitFor(async () => expect((await updates.state()).log.map((entry) => `${entry.action} ${entry.outcome}`)).toEqual(["restore ok", "switch failed", "switch ok"]));
    expect(ran).toEqual(["brew uninstall --cask codex", "npm install -g @openai/codex@latest", "brew install --cask codex"]);
  });

  it("keeps the answer and the log on disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-tool-updates-"));
    directories.push(directory);
    const file = join(directory, "runtime-tool-updates.json");
    const first = harness([], { file });
    await first.updates.setAutomatic(false);
    await first.updates.flush();
    const second = harness([provider("codex", "Codex", () => codex(() => "0.159.0"))], { file });
    expect((await second.updates.state()).automatic).toBe(false);
    expect(second.updates.updatesFor("codex")).toBeUndefined();
  });
});

describe("runToolCommand", () => {
  it("runs a fake package manager with its arguments as they are, no shell in between", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "tau-fake-npm-"));
    directories.push(directory);
    const npm = join(directory, "npm");
    const record = join(directory, "args.txt");
    await writeFile(npm, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\necho "added 1 package"\n`);
    await chmod(npm, 0o755);
    const ran = await runToolCommand({ executable: npm, args: ["install", "-g", "@openai/codex@latest; touch pwned"] }, { PATH: "/usr/bin:/bin" });
    expect(ran).toEqual({ exitCode: 0, output: "added 1 package" });
    expect((await readFile(record, "utf8")).trim().split("\n")).toEqual(["install", "-g", "@openai/codex@latest; touch pwned"]);
    const missing = await runToolCommand({ executable: join(directory, "nope"), args: [] }, {});
    expect(missing.exitCode).toBe(-1);
  });
});
