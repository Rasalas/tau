import { mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  DEFAULT_INSTANCE_ID,
  instanceIdProblem,
  runtimeInstanceKind,
  splitArguments,
  type RuntimeInstanceConfig,
} from "../shared/runtime-instances.js";
import { parseVersionPolicy, type VersionPolicy } from "../shared/version-policy.js";

export interface RuntimeInstanceSettingsOptions {
  /** A JSON file of the kit's own, e.g. `<stateDir>/settings.json`. */
  file: string;
  /** The program's backend kind, which the default instance keeps: `codex`. */
  driver: string;
  /** What the program is called: `Codex`. */
  label: string;
  /** The executable's name on the PATH when an instance names none; the driver by default. */
  executable?: string;
  /** The variable that names the default instance's executable and wins over the saved one. */
  commandVariable?: string;
  /** The variable that points the program at its home, set from an instance's `home`. */
  homeVariable?: string;
  env?: NodeJS.ProcessEnv;
}

const MAX_NAME = 60;
const NAME_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function text(value: unknown, max = 4_096): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
}

function environment(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => NAME_VARIABLE.test(entry[0]) && typeof entry[1] === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function instance(value: unknown, id?: string): RuntimeInstanceConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const instanceId = id ?? text(item.id, 48);
  if (!instanceId) return undefined;
  const fields = {
    name: text(item.name, MAX_NAME),
    command: text(item.command),
    home: text(item.home),
    env: environment(item.env),
    args: text(item.args),
  };
  return { id: instanceId, ...Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== undefined)) };
}

/** `~` and `~/…` are the user's home; anything else is taken as written. */
export function expandHome(path: string, home = homedir()): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/**
 * The instances of one program a runtime backend kit offers, kept in a file
 * of the kit's. The default instance is the file's top level, so a file from
 * before instances (`{ "command": … }`) reads as it did; the others are
 * listed under `instances`. Nothing here spawns a program or checks a path.
 */
export class RuntimeInstanceSettings {
  private default: RuntimeInstanceConfig = { id: DEFAULT_INSTANCE_ID };
  private others: RuntimeInstanceConfig[] = [];
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: RuntimeInstanceSettingsOptions) {
    this.env = options.env ?? process.env;
    try {
      const saved = JSON.parse(readFileSync(options.file, "utf8")) as Record<string, unknown>;
      this.default = instance(saved, DEFAULT_INSTANCE_ID) ?? this.default;
      const seen = new Set([DEFAULT_INSTANCE_ID]);
      this.others = (Array.isArray(saved.instances) ? saved.instances : []).flatMap((entry) => {
        const parsed = instance(entry);
        if (!parsed || instanceIdProblem(parsed.id, seen)) return [];
        seen.add(parsed.id);
        return [parsed];
      });
    } catch { /* nothing saved yet */ }
  }

  /** Every instance, the default first. */
  list(): RuntimeInstanceConfig[] {
    return [this.default, ...this.others].map((entry) => ({ ...entry, ...(entry.env ? { env: { ...entry.env } } : {}) }));
  }

  get(id: string): RuntimeInstanceConfig | undefined {
    return this.list().find((entry) => entry.id === id);
  }

  /** The backend kind an instance registers as. */
  kind(id: string): string {
    return runtimeInstanceKind(this.options.driver, id);
  }

  /** The instance's name where the workbench shows it: the program's for the default, else “Codex · Work”. */
  label(id: string): string {
    const name = this.get(id)?.name;
    if (!name) return id === DEFAULT_INSTANCE_ID ? this.options.label : `${this.options.label} · ${id}`;
    return id === DEFAULT_INSTANCE_ID || name.toLowerCase().includes(this.options.label.toLowerCase()) ? name : `${this.options.label} · ${name}`;
  }

  /** The executable an instance runs and who chose it; the variable wins for the default instance only. */
  command(id: string): { command: string; source?: "env" | "setting" } {
    const variable = this.options.commandVariable;
    const fromEnv = id === DEFAULT_INSTANCE_ID && variable ? this.env[variable]?.trim() : undefined;
    if (fromEnv) return { command: fromEnv, source: "env" };
    const saved = this.get(id)?.command;
    return saved ? { command: saved, source: "setting" } : { command: this.options.executable ?? this.options.driver };
  }

  /** The instance's home folder, expanded; undefined leaves the program's own. */
  home(id: string): string | undefined {
    const home = this.get(id)?.home;
    return home ? expandHome(home) : undefined;
  }

  /** The environment an instance's program starts with: the host's, its variables, its home. */
  environment(id: string, base: NodeJS.ProcessEnv = this.env): NodeJS.ProcessEnv {
    const entry = this.get(id);
    const home = this.home(id);
    return {
      ...base,
      ...(entry?.env ?? {}),
      ...(home && this.options.homeVariable ? { [this.options.homeVariable]: home } : {}),
    };
  }

  /** The instance's extra launch arguments, split as a shell would. */
  args(id: string): string[] {
    return splitArguments(this.get(id)?.args);
  }

  /**
   * Adds an instance or replaces one; the answer is what was kept. A new id
   * must be free; a home must be absolute once `~` is expanded.
   */
  async save(input: RuntimeInstanceConfig): Promise<RuntimeInstanceConfig> {
    const exists = input.id === DEFAULT_INSTANCE_ID || this.others.some((entry) => entry.id === input.id);
    if (!exists) {
      const problem = instanceIdProblem(input.id, this.others.map((entry) => entry.id));
      if (problem) throw new Error(problem);
    }
    const kept = instance(input, input.id);
    if (!kept) throw new Error("This is not an instance.");
    if (input.env && Object.keys(input.env).some((name) => !NAME_VARIABLE.test(name))) throw new Error("A variable name has letters, digits and _ only, and does not start with a digit.");
    if (kept.home && !isAbsolute(expandHome(kept.home))) throw new Error("The home folder has to be an absolute path or start with ~/.");
    if (kept.id === DEFAULT_INSTANCE_ID) this.default = kept;
    else if (exists) this.others = this.others.map((entry) => entry.id === kept.id ? kept : entry);
    else this.others = [...this.others, kept];
    await this.persist();
    return { ...kept };
  }

  /** Forgets an instance; the default one stays. */
  async remove(id: string): Promise<void> {
    if (id === DEFAULT_INSTANCE_ID) throw new Error("The default instance cannot be removed.");
    if (!this.others.some((entry) => entry.id === id)) return;
    this.others = this.others.filter((entry) => entry.id !== id);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const { id: _id, ...top } = this.default;
    const file = { ...top, ...(this.others.length ? { instances: this.others } : {}) };
    mkdirSync(dirname(this.options.file), { recursive: true });
    // A fresh file takes the mode; renaming it over the old one keeps a write atomic and private.
    const temporary = `${this.options.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.options.file);
  }
}

/**
 * The version policy a kit ships, unless `TAU_VERSION_POLICY` names one for
 * this program: a JSON object keyed by backend kind, for a test instance or a
 * policy that has to change before the next release.
 */
export function runtimeVersionPolicy(driver: string, bundled: VersionPolicy | undefined, env: NodeJS.ProcessEnv = process.env): VersionPolicy | undefined {
  const raw = env.TAU_VERSION_POLICY?.trim();
  if (!raw) return bundled;
  try {
    const override = (JSON.parse(raw) as Record<string, unknown>)[driver];
    return override === undefined ? bundled : parseVersionPolicy(override) ?? bundled;
  } catch {
    return bundled;
  }
}
