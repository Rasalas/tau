import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SCRIPTS, SCRIPT_KEYS, parseProjectFile, readProjectScripts, scriptSlug } from "./project-file.js";
import { SCRIPT_ICONS } from "./protocol.js";

const SOURCE = "/repo/.tau/project.json";
const parse = (value: unknown) => parseProjectFile(typeof value === "string" ? value : JSON.stringify(value), SOURCE);

describe("parseProjectFile", () => {
  it("reads a valid file with every field and applies the defaults", () => {
    const { scripts, problems } = parse({
      $schema: "./project.schema.json",
      workspaceMode: "worktree",
      scripts: [
        { name: "Dev server", command: "python3 -m http.server 8000", icon: "play", keybinding: "mod+shift+r", previewUrl: "http://localhost:8000" },
        { id: "install", name: "Install", command: "npm ci", icon: "configure", runOnWorktreeCreate: true, async: false },
        { name: "Test", command: "npm test", previewUrl: "http://localhost:3000/report", autoOpenPreview: false },
      ],
    });
    expect(problems).toEqual([]);
    expect(scripts).toEqual([
      { id: "dev-server", name: "Dev server", command: "python3 -m http.server 8000", icon: "play", keybinding: "mod+shift+r", runOnWorktreeCreate: false, async: true, previewUrl: "http://localhost:8000/", autoOpenPreview: true },
      { id: "install", name: "Install", command: "npm ci", icon: "configure", runOnWorktreeCreate: true, async: false, autoOpenPreview: false },
      { id: "test", name: "Test", command: "npm test", icon: "play", runOnWorktreeCreate: false, async: true, previewUrl: "http://localhost:3000/report", autoOpenPreview: false },
    ]);
  });

  it("turns the old top-level runOnWorktreeCreate string into a blocking setup script, with a warning", () => {
    const { scripts, problems } = parse({ runOnWorktreeCreate: "  npm ci  ", scripts: [{ name: "Build", command: "npm run build" }] });
    expect(scripts.map((script) => [script.id, script.command, script.runOnWorktreeCreate, script.async])).toEqual([
      ["setup", "npm ci", true, false],
      ["build", "npm run build", false, true],
    ]);
    expect(problems).toEqual([expect.objectContaining({ source: SOURCE, level: "warning", message: expect.stringContaining("old spelling") })]);
  });

  it("answers with an error and no scripts for a file that is not a JSON object", () => {
    expect(parse("{ scripts: [")).toEqual({ scripts: [], problems: [expect.objectContaining({ level: "error", message: expect.stringContaining("Not valid JSON") })] });
    expect(parse([1, 2])).toEqual({ scripts: [], problems: [expect.objectContaining({ level: "error", message: "The file must hold a JSON object." })] });
    expect(parse({ scripts: {} }).problems).toEqual([expect.objectContaining({ level: "error", message: '"scripts" must be an array.' })]);
  });

  it("skips a bad script with an error and keeps the others", () => {
    const { scripts, problems } = parse({
      scripts: [
        { name: "Build", command: "" },
        "npm test",
        { name: "Lint", command: "npm run lint", id: "Not An Id" },
        { name: "Lint", command: "npm run lint" },
        { name: "lint", command: "npm run lint:fix" },
        { name: "???", command: "true" },
        { name: "Serve", command: "npm start" },
      ],
    });
    expect(scripts.map((script) => script.id)).toEqual(["lint", "serve"]);
    expect(problems.map((problem) => [problem.level, problem.message])).toEqual([
      ["error", 'scripts[0]: "command" is missing or empty.'],
      ["error", "scripts[1] must be an object."],
      ["error", 'scripts[2] ("Lint"): "id" must be lowercase letters, digits and dashes, at most 40.'],
      ["error", 'scripts[4]: the id "lint" is taken by an earlier script; give it an "id" of its own.'],
      ["error", 'scripts[5] ("???"): no id can be made from the name; add an "id" of lowercase letters, digits and dashes.'],
    ]);
  });

  it("warns about fields it ignores or corrects", () => {
    const { scripts, problems } = parse({
      scripts: [{ name: "Dev", command: "npm run dev", icon: "rocket", previewUrl: "file:///etc/passwd", async: "yes", keybinding: "", colour: "red" }],
    });
    expect(scripts).toEqual([{ id: "dev", name: "Dev", command: "npm run dev", icon: "play", runOnWorktreeCreate: false, async: true, autoOpenPreview: false }]);
    expect(problems.every((problem) => problem.level === "warning")).toBe(true);
    expect(problems.map((problem) => problem.message)).toEqual([
      'scripts[0] ("Dev"): unknown field "colour" was ignored.',
      'scripts[0] ("Dev"): "icon" must be one of play, test, lint, configure, build, debug; "play" is used.',
      'scripts[0] ("Dev"): "keybinding" must be a chord such as "mod+shift+r"; it was ignored.',
      'scripts[0] ("Dev"): "previewUrl" must be an http or https URL; it was ignored.',
      'scripts[0] ("Dev"): "async" must be true or false; true is used.',
      'scripts[0] ("Dev"): "async" only matters with "runOnWorktreeCreate": true.',
    ]);
  });

  it("reads at most the first fifty scripts", () => {
    const many = Array.from({ length: MAX_SCRIPTS + 5 }, (_, index) => ({ name: `Script ${index}`, command: "true" }));
    const { scripts, problems } = parse({ scripts: many });
    expect(scripts).toHaveLength(MAX_SCRIPTS);
    expect(problems).toEqual([expect.objectContaining({ level: "warning", message: `Only the first ${MAX_SCRIPTS} scripts are read.` })]);
  });

  it("slugs a name into an id", () => {
    expect(scriptSlug("Dev Server (8000)")).toBe("dev-server-8000");
    expect(scriptSlug("Äpfel & Birnen")).toBe("apfel-birnen");
  });
});

describe("readProjectScripts", () => {
  const made: string[] = [];
  afterEach(async () => { await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
  const checkout = async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-project-scripts-"));
    made.push(directory);
    return directory;
  };

  it("answers a missing file with no scripts and no problem", async () => {
    const directory = await checkout();
    expect(await readProjectScripts(directory)).toEqual({ directory, file: join(directory, ".tau", "project.json"), exists: false, scripts: [], problems: [] });
  });

  it("reads the file of a checkout", async () => {
    const directory = await checkout();
    await mkdir(join(directory, ".tau"));
    await writeFile(join(directory, ".tau", "project.json"), JSON.stringify({ scripts: [{ name: "Build", command: "make" }] }));
    const state = await readProjectScripts(directory);
    expect(state).toMatchObject({ exists: true, problems: [], scripts: [{ id: "build", command: "make" }] });
  });

  it("reports a file it cannot read", async () => {
    const directory = await checkout();
    await mkdir(join(directory, ".tau", "project.json"), { recursive: true });
    const state = await readProjectScripts(directory);
    expect(state.problems).toEqual([expect.objectContaining({ level: "error", message: expect.stringContaining("Could not read the file") })]);
  });
});

// The published schema is what an editor checks the file against; it has to say what the parser reads.
describe("docs/schemas/project.schema.json", () => {
  it("names the fields, icons and limits the parser uses", async () => {
    const schema = JSON.parse(await readFile(new URL("../../docs/schemas/project.schema.json", import.meta.url), "utf8"));
    const script = schema.$defs.script;
    expect(Object.keys(script.properties).sort()).toEqual([...SCRIPT_KEYS].sort());
    expect(script.properties.icon.enum).toEqual([...SCRIPT_ICONS]);
    expect(script.required).toEqual(["name", "command"]);
    expect(schema.properties.scripts.maxItems).toBe(MAX_SCRIPTS);
  });
});
