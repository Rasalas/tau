import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeInstanceSettings, expandHome, runtimeVersionPolicy } from "./runtime-instance-settings.js";
import { packageInstallCommand } from "./cli-versions.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function settingsFile(contents?: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-instances-"));
  directories.push(directory);
  const file = join(directory, "settings.json");
  if (contents !== undefined) await writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

const make = (file: string, env: NodeJS.ProcessEnv = {}) => new RuntimeInstanceSettings({ file, driver: "codex", label: "Codex", commandVariable: "TAU_CODEX_COMMAND", homeVariable: "CODEX_HOME", env });

describe("RuntimeInstanceSettings", () => {
  it("reads a file from before instances as the default instance", async () => {
    const settings = make(await settingsFile({ command: "/opt/codex/bin/codex" }));
    expect(settings.list()).toEqual([{ id: "default", command: "/opt/codex/bin/codex" }]);
    expect(settings.command("default")).toEqual({ command: "/opt/codex/bin/codex", source: "setting" });
    expect(settings.kind("default")).toBe("codex");
    expect(settings.label("default")).toBe("Codex");
  });

  it("starts with the default instance alone, from a missing or broken file", async () => {
    expect(make(await settingsFile()).list()).toEqual([{ id: "default" }]);
    expect(make(await settingsFile("{nope")).list()).toEqual([{ id: "default" }]);
  });

  it("adds, edits and removes instances and writes them beside the default's fields, privately", async () => {
    const file = await settingsFile({ command: "codex-beta" });
    const settings = make(file, { PATH: "/bin", CODEX_HOME: "/shadow/default" });
    await settings.save({ id: "work", name: "Work", home: "~/.codex-work", env: { OPENAI_BASE_URL: "http://localhost:1" }, args: "-c 'a=1' --x" });
    expect(settings.kind("work")).toBe("codex@work");
    expect(settings.label("work")).toBe("Codex · Work");
    expect(settings.command("work")).toEqual({ command: "codex" });
    expect(settings.home("work")).toBe(join(homedir(), ".codex-work"));
    expect(settings.args("work")).toEqual(["-c", "a=1", "--x"]);
    expect(settings.environment("work")).toEqual({ PATH: "/bin", CODEX_HOME: join(homedir(), ".codex-work"), OPENAI_BASE_URL: "http://localhost:1" });
    // The default instance keeps the home the host's environment gives it.
    expect(settings.environment("default").CODEX_HOME).toBe("/shadow/default");
    await settings.save({ id: "work", name: "Codex for work" });
    expect(settings.label("work")).toBe("Codex for work");
    await settings.save({ id: "second" });
    expect(settings.label("second")).toBe("Codex · second");

    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved).toEqual({ command: "codex-beta", instances: [{ id: "work", name: "Codex for work" }, { id: "second" }] });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(make(file).list().map((entry) => entry.id)).toEqual(["default", "work", "second"]);

    await settings.remove("work");
    expect(settings.list().map((entry) => entry.id)).toEqual(["default", "second"]);
    await expect(settings.remove("default")).rejects.toThrow("cannot be removed");
  });

  it("refuses a taken or malformed id, a relative home and a bad variable name", async () => {
    const settings = make(await settingsFile());
    await settings.save({ id: "work" });
    await expect(settings.save({ id: "Work Two" })).rejects.toThrow("starts with a letter");
    await expect(settings.save({ id: "other", home: "relative/home" })).rejects.toThrow("absolute path");
    await expect(settings.save({ id: "other", env: { "1BAD": "x" } })).rejects.toThrow("variable name");
    // Saving an existing id edits it rather than refusing it as taken.
    await expect(settings.save({ id: "work", name: "Work" })).resolves.toEqual({ id: "work", name: "Work" });
  });

  it("lets the command variable win for the default instance only", async () => {
    const settings = make(await settingsFile({ command: "/saved/codex", instances: [{ id: "work", command: "/work/codex" }] }), { TAU_CODEX_COMMAND: "/dev/codex" });
    expect(settings.command("default")).toEqual({ command: "/dev/codex", source: "env" });
    expect(settings.command("work")).toEqual({ command: "/work/codex", source: "setting" });
  });

  it("drops a saved instance whose id is malformed or repeated", async () => {
    const settings = make(await settingsFile({ instances: [{ id: "ok" }, { id: "ok" }, { id: "Bad" }, { name: "no id" }] }));
    expect(settings.list().map((entry) => entry.id)).toEqual(["default", "ok"]);
  });
});

describe("helpers for a CLI's releases", () => {
  it("expands ~ to the user's home", () => {
    expect(expandHome("~", "/Users/me")).toBe("/Users/me");
    expect(expandHome("~/.codex", "/Users/me")).toBe("/Users/me/.codex");
    expect(expandHome("/abs", "/Users/me")).toBe("/abs");
  });

  it("takes a policy from TAU_VERSION_POLICY for its program, else the bundled one", () => {
    const bundled = { ranges: [{ range: "<1.0.0", status: "broken" as const }] };
    expect(runtimeVersionPolicy("codex", bundled, {})).toBe(bundled);
    expect(runtimeVersionPolicy("codex", bundled, { TAU_VERSION_POLICY: JSON.stringify({ codex: { ranges: [{ range: ">=0.1.0", status: "unsafe" }] } }) })).toEqual({ ranges: [{ range: ">=0.1.0", status: "unsafe" }] });
    expect(runtimeVersionPolicy("codex", bundled, { TAU_VERSION_POLICY: JSON.stringify({ "claude-code": { ranges: [] } }) })).toBe(bundled);
    expect(runtimeVersionPolicy("codex", bundled, { TAU_VERSION_POLICY: "{broken" })).toBe(bundled);
  });

  it("names the command that installs one release, for a package manager that can pin it", () => {
    expect(packageInstallCommand("/usr/local/lib/node_modules/@openai/codex/bin/codex.js", "@openai/codex", "0.154.0")).toBe("npm install -g @openai/codex@0.154.0");
    expect(packageInstallCommand("/Users/me/Library/pnpm/global/5/node_modules/@openai/codex/bin/codex.js", "@openai/codex", "0.154.0")).toBe("pnpm add -g @openai/codex@0.154.0");
    expect(packageInstallCommand("/Users/me/.bun/install/global/node_modules/@openai/codex/bin/codex.js", "@openai/codex", "0.154.0")).toBe("bun add -g @openai/codex@0.154.0");
    expect(packageInstallCommand("/opt/homebrew/Caskroom/codex/0.154.0/codex", "@openai/codex", "0.154.0")).toBeUndefined();
  });
});
