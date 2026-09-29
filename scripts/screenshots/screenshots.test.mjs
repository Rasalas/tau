import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFixture } from "./fixture.mjs";
import { descendants, instanceEnv, outputsOf, parseArgs, themesOf } from "./run.mjs";
import { studioEnv } from "./studio.mjs";
import { SHOTS, SHOT_NAMES, selectShots } from "./shots.mjs";

const TAU_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("screenshot scenarios", () => {
  it("names each shot once, the ones the website uses", () => {
    expect(SHOT_NAMES).toEqual(["reviews", "workbench", "juicebars", "threads", "stage", "runtimes", "usage", "kits", "machines", "phone"]);
    for (const shot of SHOTS) {
      expect(["desktop", "phone"]).toContain(shot.device);
      expect(typeof shot.run).toBe("function");
    }
  });

  it("selects shots in list order and refuses unknown names", () => {
    expect(selectShots(["phone", "reviews"]).map((shot) => shot.name)).toEqual(["reviews", "phone"]);
    expect(selectShots([]).length).toBe(SHOTS.length);
    expect(() => selectShots(["hero"])).toThrow(/unknown shot hero/u);
  });

  it("reads the runner's flags", () => {
    expect(parseArgs(["--out", "/tmp/shots", "--only", "workbench,phone", "--theme", "dark"])).toMatchObject({ out: "/tmp/shots", only: ["workbench", "phone"], theme: "dark", build: false });
    expect(() => parseArgs([])).toThrow(/--out/u);
    expect(() => parseArgs(["--out", "x", "--theme", "blue"])).toThrow(/light, dark or both/u);
    expect(parseArgs(["--out", "x", "--theme", "both", "--format", "webp"])).toMatchObject({ theme: "both", format: "webp" });
    expect(() => parseArgs(["--out", "x", "--format", "gif"])).toThrow(/png or webp/u);
  });

  it("names a run's files by theme and size", () => {
    expect(themesOf("both")).toEqual([{ theme: "light", suffix: "" }, { theme: "dark", suffix: "-dark" }]);
    expect(themesOf("dark")).toEqual([{ theme: "dark", suffix: "" }]);
    expect(outputsOf("png")).toEqual([{ suffix: "", format: "png", scale: 1 }]);
    expect(outputsOf("webp").map((output) => `${output.suffix}:${output.scale}`)).toEqual([":1", "-sm:0.5"]);
  });

  it("finds a process's descendants from a ps table", () => {
    const table = " 10 1 app\n 11 10 host\n 12 11 zsh -il\n 13 1 other\n";
    expect(descendants(10, table).map((row) => row.pid)).toEqual([11, 12]);
  });
});

describe("screenshot fixture", () => {
  let root;
  let fixture;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tau-screenshots-test-")));
    fixture = writeFixture({ root, baseUrl: "http://127.0.0.1:9/v1", tauRoot: TAU_ROOT });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("writes threads on the Agent SDK runtime, Codex and Pi, and none of Pi's on Anthropic", () => {
    const sdk = JSON.parse(readFileSync(join(root, "tau", "claude-runtime-sessions.json"), "utf8")).sessions;
    const codex = JSON.parse(readFileSync(join(root, "tau", "codex-runtime-sessions.json"), "utf8")).sessions;
    const pi = readdirSync(fixture.sessions).map((file) => readFileSync(join(fixture.sessions, file), "utf8"));
    expect(sdk.length).toBe(3);
    expect(codex.length).toBe(3);
    expect(pi.length).toBe(3);
    for (const text of pi) expect(text).not.toMatch(/"provider":"anthropic"|claude-/u);
    const models = JSON.parse(readFileSync(join(fixture.agentDir, "models.json"), "utf8"));
    expect(Object.keys(models.providers)).not.toContain("anthropic");
  });

  it("keeps every path the instance uses inside the run folder", () => {
    // instanceEnv throws when a data path leaves the run folder or names a real home's folder.
    const env = instanceEnv(fixture);
    expect(env.HOME.startsWith(`${root}/`)).toBe(true);
    expect(env.TAU_WORKSPACE).toBe(fixture.projects.shop);
  });

  it("writes six weeks of outside usage in the CLIs' own formats, and runtimes that read as installed", () => {
    const rollouts = readdirSync(join(fixture.codexHome, "sessions"), { recursive: true }).filter((name) => String(name).endsWith(".jsonl"));
    const projects = readdirSync(join(fixture.sdkHome, "projects"), { recursive: true }).filter((name) => String(name).endsWith(".jsonl"));
    expect(rollouts.length).toBeGreaterThan(20);
    expect(projects.length).toBe(rollouts.length);
    const line = JSON.parse(readFileSync(join(fixture.sdkHome, "projects", projects[0]), "utf8").split("\n")[0]);
    expect(line).toMatchObject({ type: "assistant", message: { usage: expect.any(Object) } });
    expect(readdirSync(fixture.bin)).toContain("opencode");
    // The pinned Antigravity release in kits/antigravity/release.ts, so the sample copy reads as current.
    const pinned = readFileSync(join(TAU_ROOT, "kits", "antigravity", "release.ts"), "utf8").match(/ANTIGRAVITY_RELEASE_VERSION = "([^"]+)"/u)[1];
    const managed = join(fixture.userData, "kit-state", "tau.antigravity", "tools", "antigravity-acp", `${process.platform}-${process.arch}`);
    const { releaseId } = JSON.parse(readFileSync(join(managed, "active.json"), "utf8"));
    expect(JSON.parse(readFileSync(join(managed, "versions", releaseId, ".install-complete.json"), "utf8")).version).toBe(pinned);
  });

  it("keeps the second machine's data under the run folder", () => {
    const { dir, env } = studioEnv({ root, tauRoot: TAU_ROOT, base: { PATH: "/usr/bin:/bin" } });
    expect(dir).toBe(join(root, "studio"));
    for (const key of ["HOME", "TAU_USER_DATA", "TAU_HOST_TOKEN_FILE", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"]) expect(env[key].startsWith(`${dir}/`)).toBe(true);
    expect(env.TAU_HOST_LISTEN).toBe("127.0.0.1:0");
  });

  it("leaves a note and a merge in Review Kit's book", () => {
    const book = JSON.parse(readFileSync(join(fixture.userData, "kit-state", "tau.review", "local-reviews.json"), "utf8"));
    expect(Object.keys(book.asks)).toEqual([`${fixture.projects.shop}\ndocs/webhook-retries`]);
    expect(book.merged[0]).toMatchObject({ branch: "chore/deps", target: "main" });
  });
});
