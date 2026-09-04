import { basename } from "node:path";
import type { UiProject } from "../shared/contracts.js";
import { resolveProjectIcon } from "./project-icon.js";
import { type PersistedJsonLogger, readPersistedJson, writePersistedJson } from "./persisted-json.js";

const MAX_PROJECTS = 24;
/** Bumped when the stored shape changes; `load()` stays backward compatible. */
const CURRENT_VERSION = 1;

type ProjectIconResolver = (path: string) => Promise<string | undefined>;

interface NormalizedStored {
  projects: unknown;
  hiddenPaths: unknown;
}

function normalizeStored(value: unknown): NormalizedStored | undefined {
  if (Array.isArray(value)) return { projects: value, hiddenPaths: [] };
  if (!value || typeof value !== "object") return undefined;
  const stored = value as { projects?: unknown; hiddenPaths?: unknown };
  return { projects: stored.projects, hiddenPaths: stored.hiddenPaths };
}

const defaultLogger: PersistedJsonLogger = { warn: (message, detail) => console.warn(message, detail) };

export class ProjectHistory {
  private projects: UiProject[] = [];
  private hiddenPaths = new Set<string>();
  private dirty = false;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly resolveIcon: ProjectIconResolver = resolveProjectIcon,
    private readonly logger: PersistedJsonLogger = defaultLogger,
  ) {}

  async load(): Promise<void> {
    const result = await readPersistedJson(this.filePath, {
      expectedVersion: CURRENT_VERSION,
      decode: (value) => {
        const stored = normalizeStored(value);
        if (!stored || !Array.isArray(stored.projects)) return undefined;
        return {
          projects: stored.projects,
          hiddenPaths: Array.isArray(stored.hiddenPaths)
            ? stored.hiddenPaths.filter((path): path is string => typeof path === "string")
            : [],
        };
      },
      logger: this.logger,
    });
    if (!result) return;
    try {
      this.hiddenPaths = new Set(result.data.hiddenPaths);
      const projects = result.data.projects
        .filter((item): item is UiProject => {
          if (!item || typeof item !== "object") return false;
          const project = item as Partial<UiProject>;
          return typeof project.path === "string" && typeof project.lastOpenedAt === "number";
        })
        .slice(0, MAX_PROJECTS);
      this.projects = await Promise.all(projects.map(async (project) => ({
        path: project.path,
        name: project.name || basename(project.path) || project.path,
        lastOpenedAt: project.lastOpenedAt,
        ...await this.icon(project.path),
      })));
    } catch (error) {
      // Valid JSON but something in the shape or icon lookup blew up: start
      // empty like before, but this is not corruption, so the file stays put.
      this.logger.warn(`project history: could not read ${this.filePath}`, error);
      this.projects = [];
    }
  }

  list(): UiProject[] {
    return this.projects.map((project) => ({ ...project }));
  }

  isHidden(path: string): boolean {
    return this.hiddenPaths.has(path);
  }

  async remove(path: string): Promise<void> {
    this.projects = this.projects.filter((project) => project.path !== path);
    this.hiddenPaths.add(path);
    this.schedulePersist();
  }

  async remember(path: string, name = basename(path) || path): Promise<void> {
    const project: UiProject = {
      path,
      name,
      lastOpenedAt: Date.now(),
      ...await this.icon(path),
    };
    this.projects = [project, ...this.projects.filter((item) => item.path !== path)].slice(
      0,
      MAX_PROJECTS,
    );
    this.hiddenPaths.delete(path);
    this.schedulePersist();
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist().catch(() => {
        // Persistence is retried by the next mutation or surfaced by flush().
      });
    }, 100);
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (this.dirty) await this.persist();
    await this.persistQueue;
  }

  private async icon(path: string): Promise<Pick<UiProject, "icon">> {
    try {
      const icon = await this.resolveIcon(path);
      return icon ? { icon } : {};
    } catch {
      return {};
    }
  }

  private persist(): Promise<void> {
    if (!this.dirty) return this.persistQueue;
    this.dirty = false;
    const storedProjects = this.projects.map(({ icon: _icon, ...project }) => project);
    this.persistQueue = this.persistQueue.catch(() => undefined).then(() => writePersistedJson(
      this.filePath,
      CURRENT_VERSION,
      { projects: storedProjects, hiddenPaths: [...this.hiddenPaths] },
      { logger: this.logger },
    ));
    return this.persistQueue;
  }
}
