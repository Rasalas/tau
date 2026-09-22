import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  AgentAccessLevel,
  AgentDefinitionSummary,
  AgentDefinitionsState,
  AgentWorkspaceMode,
} from "./protocol.js";
import { parseModel } from "./threads.js";

/**
 * Agent definitions a project checks in: one Markdown file per agent under
 * `.tau/agents/`, a frontmatter block for the settings and the body as the
 * agent's system prompt. `docs/agent-definitions.md` is the format.
 */
export const AGENT_DEFINITIONS_FOLDER = join(".tau", "agents");

export interface AgentDefinition extends AgentDefinitionSummary {
  systemPrompt: string;
}

/** What discovery found in one project: the usable definitions and every file that is not. */
export interface AgentDefinitionsReport extends AgentDefinitionsState {
  definitions: AgentDefinition[];
  /** Files that failed, under the name they would have had, so a spawn can say why. */
  invalid: Array<{ name: string; file: string; message: string }>;
}

const MAX_FILES = 200;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_PROMPT = 32_000;
const MAX_DESCRIPTION = 500;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const RUNTIME = /^[a-z][a-z0-9-]{0,63}$/u;
const TOOL = /^[A-Za-z0-9_.-]{1,128}$/u;
const KEY = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const KNOWN_KEYS = new Set(["name", "description", "model", "runtime", "tools", "access", "workspace"]);

type FieldValue = string | string[];

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * The frontmatter subset agent files use: `key: value`, quoted or not, and
 * lists either inline (`[a, b]`) or as `- item` lines under an empty key.
 * Anything else is an error that names its line, rather than a guess.
 */
export function parseFrontmatter(text: string): { fields: Map<string, FieldValue>; body: string } {
  const lines = text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") throw new Error("The file must start with a --- line that opens its frontmatter.");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) throw new Error("The frontmatter has no closing --- line.");
  const fields = new Map<string, FieldValue>();
  let listKey: string | undefined;
  for (let index = 1; index < end; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("- ") || trimmed === "-") {
      if (!listKey) throw new Error(`Line ${index + 1}: a list item needs a key above it.`);
      (fields.get(listKey) as string[]).push(unquote(trimmed.slice(1)));
      continue;
    }
    const colon = trimmed.indexOf(":");
    const key = colon > 0 ? trimmed.slice(0, colon).trim() : "";
    if (!KEY.test(key)) throw new Error(`Line ${index + 1}: expected "key: value".`);
    if (fields.has(key)) throw new Error(`Line ${index + 1}: "${key}" is set twice.`);
    const value = trimmed.slice(colon + 1).trim();
    listKey = undefined;
    if (!value) {
      fields.set(key, []);
      listKey = key;
    } else if (value.startsWith("[")) {
      if (!value.endsWith("]")) throw new Error(`Line ${index + 1}: the list for "${key}" is not closed.`);
      fields.set(key, value.slice(1, -1).split(",").map(unquote).filter(Boolean));
    } else {
      fields.set(key, unquote(value));
    }
  }
  return { fields, body: lines.slice(end + 1).join("\n").trim() };
}

function scalar(fields: Map<string, FieldValue>, key: string): string | undefined {
  const value = fields.get(key);
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    throw new Error(`"${key}" takes one value, not a list.`);
  }
  return value || undefined;
}

/** `tools: read, grep` and both list spellings read the same. */
function list(fields: Map<string, FieldValue>, key: string): string[] | undefined {
  const value = fields.get(key);
  if (value === undefined) return undefined;
  const items = (Array.isArray(value) ? value : value.split(",")).map((item) => item.trim()).filter(Boolean);
  return items;
}

/**
 * One file read into a definition. It either yields the definition, with
 * warnings for what it ignored, or fails with one message.
 */
export function parseAgentDefinition(file: string, text: string): { definition: AgentDefinition; warnings: string[] } {
  const { fields, body } = parseFrontmatter(text);
  const warnings = [...fields.keys()].filter((key) => !KNOWN_KEYS.has(key)).map((key) => `"${key}" is not a field agent definitions have; it was ignored.`);

  const name = scalar(fields, "name") ?? basename(file).replace(/\.md$/iu, "");
  if (!NAME.test(name)) throw new Error(`The name "${name}" must be lowercase letters, digits, - or _, up to 64 characters.`);

  const description = scalar(fields, "description");
  if (!description) throw new Error("\"description\" is required: say when a thread should use this agent.");
  if (description.length > MAX_DESCRIPTION) throw new Error(`"description" must be ${MAX_DESCRIPTION} characters or fewer.`);

  if (!body) throw new Error("The body below the frontmatter is the agent's system prompt and must not be empty.");
  if (body.length > MAX_PROMPT) throw new Error(`The system prompt must be ${MAX_PROMPT} characters or fewer.`);

  const model = scalar(fields, "model");
  if (model) parseModel(model);

  const runtime = scalar(fields, "runtime");
  if (runtime && !RUNTIME.test(runtime)) throw new Error(`"runtime" must name a runtime backend such as "pi", not "${runtime}".`);

  const tools = list(fields, "tools");
  if (tools) {
    if (tools.length === 0) throw new Error("\"tools\" lists no tool; leave it out to keep every tool.");
    const bad = tools.find((tool) => !TOOL.test(tool));
    if (bad) throw new Error(`"${bad}" is not a tool name.`);
  }

  const access = scalar(fields, "access");
  if (access && access !== "read-only" && access !== "ask" && access !== "full") {
    throw new Error("\"access\" must be read-only, ask or full.");
  }

  const workspace = scalar(fields, "workspace");
  if (workspace && workspace !== "worktree" && workspace !== "shared") {
    throw new Error("\"workspace\" must be worktree or shared.");
  }

  // Tools and access are enforced inside a Pi runtime; another backend would
  // silently run with more than the file promises.
  if (runtime && runtime !== "pi" && (tools || access)) {
    throw new Error(`"tools" and "access" only apply on the pi runtime; the ${runtime} runtime cannot honour them.`);
  }

  return {
    definition: {
      name,
      description,
      file,
      systemPrompt: body,
      ...(model ? { model } : {}),
      ...(runtime ? { runtime } : {}),
      ...(tools ? { tools: [...new Set(tools)] } : {}),
      ...(access ? { access: access as AgentAccessLevel } : {}),
      ...(workspace ? { workspace: workspace as AgentWorkspaceMode } : {}),
    },
    warnings,
  };
}

/** The name a broken file would have had, for the message a spawn by that name gets. */
function nameOf(file: string, text: string | undefined): string {
  const declared = text?.match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/mu)?.[1];
  return declared?.trim() || basename(file).replace(/\.md$/iu, "");
}

/** What a panel and the Inspector need of a definition; the prompt stays on the host. */
export function summarize(definition: AgentDefinition): AgentDefinitionSummary {
  const { systemPrompt: _prompt, ...summary } = definition;
  return summary;
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  outcome: { definition: AgentDefinition; warnings: string[] } | { error: string; name: string };
}

/**
 * Reads every `*.md` in a project's `.tau/agents/`. A file that changed is
 * parsed again; the others come from the cache, so the per-turn read a
 * runtime does costs a directory listing and a stat per file.
 */
export class AgentDefinitionReader {
  private readonly files = new Map<string, CachedFile>();

  async read(projectPath: string): Promise<AgentDefinitionsReport> {
    const directory = join(projectPath, AGENT_DEFINITIONS_FOLDER);
    const report: AgentDefinitionsReport = { directory, definitions: [], problems: [], invalid: [] };
    let names: string[];
    try {
      names = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return report;
    }
    if (names.length > MAX_FILES) {
      report.problems.push({ file: directory, message: `Only the first ${MAX_FILES} of ${names.length} files are read.`, level: "warning" });
      names = names.slice(0, MAX_FILES);
    }
    const taken = new Map<string, string>();
    const fail = (file: string, name: string, message: string) => {
      report.problems.push({ file, message, level: "error" });
      report.invalid.push({ name, file, message });
    };
    for (const entry of names) {
      const file = join(directory, entry);
      const outcome = await this.parse(file);
      if (!outcome) continue;
      if ("error" in outcome) {
        fail(file, outcome.name, outcome.error);
        continue;
      }
      const { definition, warnings } = outcome;
      const owner = taken.get(definition.name);
      if (owner) {
        fail(file, definition.name, `The name "${definition.name}" is already taken by ${basename(owner)}.`);
        continue;
      }
      taken.set(definition.name, file);
      report.definitions.push(definition);
      for (const warning of warnings) report.problems.push({ file, message: warning, level: "warning" });
    }
    return report;
  }

  private async parse(file: string): Promise<CachedFile["outcome"] | undefined> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(file);
    } catch {
      return undefined;
    }
    const cached = this.files.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.outcome;
    let outcome: CachedFile["outcome"];
    let text: string | undefined;
    try {
      if (info.size > MAX_FILE_BYTES) throw new Error(`The file is larger than ${MAX_FILE_BYTES / 1024} KiB.`);
      text = await readFile(file, "utf8");
      outcome = parseAgentDefinition(file, text);
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error), name: nameOf(file, text) };
    }
    this.files.set(file, { mtimeMs: info.mtimeMs, size: info.size, outcome });
    return outcome;
  }
}

/** The definition a spawn named, or an error that says what to name instead. */
export function findAgentDefinition(report: AgentDefinitionsReport, name: string): AgentDefinition {
  const found = report.definitions.find((definition) => definition.name === name);
  if (found) return found;
  const broken = report.invalid.find((entry) => entry.name === name);
  if (broken) throw new Error(`The agent definition "${name}" (${broken.file}) is invalid: ${broken.message}`);
  const available = report.definitions.map((definition) => definition.name);
  throw new Error(`No agent definition "${name}" in ${report.directory}. ${available.length > 0
    ? `Available: ${available.join(", ")}.`
    : "This project defines none; leave agent out."}`);
}
