import { basename } from "node:path";
import type { UiProject } from "../shared/contracts.js";
import type { WorkspaceRef } from "../shared/workspace-identity.js";
import { resolveProjectIcon } from "./project-icon.js";
import { type PersistedJsonLogger, readPersistedJson, writePersistedJson } from "./persisted-json.js";

const MAX_PROJECTS = 24;
/** 2: entries and the hidden list are keyed by workspace id, not by path. */
const CURRENT_VERSION = 2;

type ProjectIconResolver = (path: string) => Promise<string | undefined>;
type WorkspaceIdentifier = (path: string) => WorkspaceRef;

interface NormalizedStored {
  projects: unknown;
  hidden: unknown;
}

function normalizeStored(value: unknown): NormalizedStored | undefined {
  if (Array.isArray(value)) return { projects: value, hidden: [] };
  if (!value || typeof value !== "object") return undefined;
  const stored = value as { projects?: unknown; hidden?: unknown; hiddenPaths?: unknown };
  // Version 1 hid projects by path; those paths become ids on load.
  return { projects: stored.projects, hidden: stored.hidden ?? stored.hiddenPaths };
}

const defaultLogger: PersistedJsonLogger = { warn: (message, detail) => console.warn(message, detail) };

export class ProjectHistory {
  private projects: UiProject[] = [];
  /** Keyed by workspace id; a legacy file's paths are converted while loading. */
  private hidden = new Set<string>();
  private dirty = false;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly resolveIcon: ProjectIconResolver = resolveProjectIcon,
    private readonly logger: PersistedJsonLogger = defaultLogger,
    /** Mints the id a project is stored and addressed under; without one, its path is the key. */
    private readonly identify?: WorkspaceIdentifier,
  ) {}

  private key(path: string): string {
    return this.identify?.(path).workspaceId ?? path;
  }

  async load(): Promise<void> {
    const result = await readPersistedJson(this.filePath, {
      expectedVersion: CURRENT_VERSION,
      decode: (value) => {
        const stored = normalizeStored(value);
        if (!stored || !Array.isArray(stored.projects)) return undefined;
        return {
          projects: stored.projects,
          hidden: Array.isArray(stored.hidden)
            ? stored.hidden.filter((entry): entry is string => typeof entry === "string")
            : [],
        };
      },
      logger: this.logger,
    });
    if (!result) return;
    try {
      // Both shapes are accepted: an id stays as it is, a v1 path becomes one.
      this.hidden = new Set(result.data.hidden.map((entry) => entry.startsWith("/") ? this.key(entry) : entry));
      const projects = result.data.projects
        .filter((item): item is UiProject => {
          if (!item || typeof item !== "object") return false;
          const project = item as Partial<UiProject>;
          return typeof project.path === "string" && typeof project.lastOpenedAt === "number";
        })
        .slice(0, MAX_PROJECTS);
      this.projects = await Promise.all(projects.map(async (project) => ({
        path: project.path,
        ...(this.identify ? this.identify(project.path) : {}),
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
    return this.hidden.has(this.key(path));
  }

  async remove(path: string): Promise<void> {
    const key = this.key(path);
    this.projects = this.projects.filter((project) => this.key(project.path) !== key);
    this.hidden.add(key);
    this.schedulePersist();
  }

  async remember(path: string, name = basename(path) || path): Promise<void> {
    const key = this.key(path);
    const project: UiProject = {
      path,
      ...(this.identify ? this.identify(path) : {}),
      name,
      lastOpenedAt: Date.now(),
      ...await this.icon(path),
    };
    this.projects = [project, ...this.projects.filter((item) => this.key(item.path) !== key)].slice(
      0,
      MAX_PROJECTS,
    );
    this.hidden.delete(key);
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
      { projects: storedProjects, hidden: [...this.hidden] },
      { logger: this.logger },
    ));
    return this.persistQueue;
  }
}
