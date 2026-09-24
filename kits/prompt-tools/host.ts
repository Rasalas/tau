import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerHostExtension, WorkerHostExtensionContext } from "tau/host";
import { recallablePrompt } from "./history.js";
import {
  MAX_STASH_ENTRIES,
  MAX_STASH_IMAGE_CHARS,
  PROJECT_HISTORY_PROMPTS,
  PROJECT_HISTORY_THREADS,
  PROMPT_TOOLS_ID,
  STASH_CHANGED_EVENT,
  type ChipKind,
  type StashedChip,
  type StashedImage,
  type StashEntry,
} from "./protocol.js";

/** Bad input, not a broken command: it reaches the caller without counting against the kit. */
function refuse(message: string): Error {
  return Object.assign(new Error(message), { name: "HostCommandError", expected: true });
}

const CHIP_KINDS: ReadonlySet<ChipKind> = new Set(["file", "text-excerpt", "pull-request", "attachment"]);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";

function readChips(value: unknown): StashedChip[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): StashedChip[] => {
    const chip = record(item);
    if (!CHIP_KINDS.has(chip.kind as ChipKind) || typeof chip.label !== "string") return [];
    return [{ kind: chip.kind as ChipKind, label: chip.label, payload: record(chip.payload) }];
  });
}

function readImages(value: unknown, withData: boolean): StashedImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): StashedImage[] => {
    const image = record(item);
    if (typeof image.name !== "string" || typeof image.mimeType !== "string" || typeof image.size !== "number") return [];
    if (withData && typeof image.data !== "string") return [];
    return [{ kind: "image", name: image.name, mimeType: image.mimeType, size: image.size, ...(withData ? { data: image.data as string } : {}) }];
  });
}

function readEntry(value: unknown): StashEntry | undefined {
  const entry = record(value);
  if (typeof entry.id !== "string" || typeof entry.createdAt !== "number") return undefined;
  return { id: entry.id, createdAt: entry.createdAt, text: text(entry.text), chips: readChips(entry.chips), images: readImages(entry.images, false) };
}

async function writeAtomically(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return undefined; }
}

/** Every entry of one project: `<id>.json` carries the draft, `<id>.images.json` its image bytes. */
export class StashFolder {
  constructor(readonly folder: string) {}

  async list(): Promise<StashEntry[]> {
    let names: string[];
    try { names = await readdir(this.folder); } catch { return []; }
    const entries = await Promise.all(names
      .filter((name) => name.endsWith(".json") && !name.endsWith(".images.json"))
      .map(async (name) => readEntry(await readJson(join(this.folder, name)))));
    return entries.filter((entry): entry is StashEntry => entry !== undefined).sort((a, b) => b.createdAt - a.createdAt);
  }

  async add(entry: StashEntry): Promise<StashEntry | undefined> {
    await mkdir(this.folder, { recursive: true });
    const images = entry.images.filter((image) => image.data !== undefined);
    // Images first, so an entry never lists images it cannot give back.
    if (images.length > 0) await writeAtomically(this.imagesPath(entry.id), images);
    await writeAtomically(this.entryPath(entry.id), { ...entry, images: entry.images.map(({ data: _data, ...meta }) => meta) });
    const all = await this.list();
    const evicted = all.slice(MAX_STASH_ENTRIES);
    await Promise.all(evicted.map((old) => this.drop(old.id)));
    return evicted[0];
  }

  async take(id: string): Promise<StashEntry | undefined> {
    const entry = readEntry(await readJson(this.entryPath(id)));
    if (!entry) return undefined;
    const images = entry.images.length > 0 ? readImages(await readJson(this.imagesPath(id)), true) : [];
    await this.drop(id);
    return { ...entry, images };
  }

  async drop(id: string): Promise<void> {
    await rm(this.entryPath(id), { force: true });
    await rm(this.imagesPath(id), { force: true });
  }

  private entryPath(id: string): string {
    if (!/^[\w-]+$/u.test(id)) throw refuse(`"${id}" is not a stash entry.`);
    return join(this.folder, `${id}.json`);
  }

  private imagesPath(id: string): string {
    return join(this.folder, `${id}.images.json`);
  }
}

/** The user prompts of one Pi session file, with the time each was sent. */
export async function sessionPrompts(path: string): Promise<Array<{ text: string; at: number }>> {
  let content: string;
  try { content = await readFile(path, "utf8"); } catch { return []; }
  const prompts: Array<{ text: string; at: number }> = [];
  for (const line of content.split("\n")) {
    if (!line.includes('"role":"user"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown; timestamp?: unknown } };
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      const body = entry.message.content;
      const raw = typeof body === "string" ? body
        : Array.isArray(body) ? body.map((part) => text(record(part).text)).join("") : "";
      const at = typeof entry.message.timestamp === "number" ? entry.message.timestamp : Date.parse(text(entry.timestamp)) || 0;
      if (raw.trim()) prompts.push({ text: raw, at });
    } catch {
      // A torn last line is the writer's, not ours.
    }
  }
  return prompts;
}

export interface PromptToolsHostOptions {
  now?(): number;
}

/**
 * The host half of `tau.prompt-tools`, in a worker: the stash under the kit's
 * own state folder, one folder per project, and the prompts of a project's
 * threads read from their session files.
 */
export function createPromptToolsHostExtension(options: PromptToolsHostOptions = {}): WorkerHostExtension & { permissions: string[] } {
  const now = options.now ?? Date.now;
  return {
    id: PROMPT_TOOLS_ID,
    name: "Prompt Tools",
    permissions: ["sessions"],
    activate(context: WorkerHostExtensionContext) {
      const services = context.services;
      const folderOf = (project: string) => {
        if (!project) throw refuse("A stash belongs to a project.");
        return new StashFolder(join(services.stateDir, "stash", createHash("sha256").update(project).digest("hex").slice(0, 16)));
      };
      // One project's writes in order; a list never reads half an eviction.
      const queues = new Map<string, Promise<unknown>>();
      const serially = <T>(project: string, work: () => Promise<T>): Promise<T> => {
        const next = (queues.get(project) ?? Promise.resolve()).then(work, work);
        queues.set(project, next.catch(() => undefined));
        return next;
      };
      const changed = (project: string) => context.emit(STASH_CHANGED_EVENT, { project });

      context.registerCommand("stash-list", (input) => {
        const project = text(record(input).project);
        return serially(project, () => folderOf(project).list());
      }, { access: "read" });

      context.registerCommand("stash-add", (input) => {
        const fields = record(input);
        const project = text(fields.project);
        const images = readImages(fields.images, true);
        if (images.reduce((sum, image) => sum + (image.data?.length ?? 0), 0) > MAX_STASH_IMAGE_CHARS) {
          throw refuse("These images are too large to stash; remove some and try again.");
        }
        const entry: StashEntry = { id: randomUUID(), createdAt: now(), text: text(fields.text), chips: readChips(fields.chips), images };
        if (!entry.text.trim() && entry.chips.length === 0 && entry.images.length === 0) throw refuse("There is nothing to stash.");
        return serially(project, async () => {
          const evicted = await folderOf(project).add(entry);
          changed(project);
          const listed = { ...entry, images: entry.images.map(({ data: _data, ...meta }) => meta) };
          return evicted ? { entry: listed, evicted } : { entry: listed };
        });
      });

      context.registerCommand("stash-take", (input) => {
        const fields = record(input);
        const project = text(fields.project);
        return serially(project, async () => {
          const entry = await folderOf(project).take(text(fields.id));
          changed(project);
          return entry;
        });
      });

      context.registerCommand("stash-drop", (input) => {
        const fields = record(input);
        const project = text(fields.project);
        return serially(project, async () => {
          await folderOf(project).drop(text(fields.id));
          changed(project);
        });
      });

      context.registerCommand("project-prompts", async (input) => {
        const fields = record(input);
        const cwd = text(fields.cwd);
        const exclude = text(fields.excludeSessionId);
        const sessions = (await services.sessions.list()).filter((session) => session.cwd === cwd && session.sessionId !== exclude);
        const dated = await Promise.all(sessions.map(async (session) => {
          try { return { path: session.path, modified: (await stat(session.path)).mtimeMs }; } catch { return undefined; }
        }));
        const newest = dated.filter((entry) => entry !== undefined).sort((a, b) => b.modified - a.modified).slice(0, PROJECT_HISTORY_THREADS);
        const prompts = (await Promise.all(newest.map((entry) => sessionPrompts(entry.path)))).flat().sort((a, b) => b.at - a.at);
        const seen = new Set<string>();
        const answer: string[] = [];
        for (const prompt of prompts) {
          const recalled = recallablePrompt(prompt.text);
          if (!recalled || seen.has(recalled)) continue;
          seen.add(recalled);
          answer.push(recalled);
          if (answer.length >= PROJECT_HISTORY_PROMPTS) break;
        }
        return answer;
      }, { access: "read", long: true });
    },
  };
}

export default createPromptToolsHostExtension;
