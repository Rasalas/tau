import type { ClientStorage, HostActionResult, HostExtensionClient, WorkbenchActions } from "tau";
import {
  IMPORT_PROGRESS_EVENT,
  SESSION_SOURCES,
  type Discovery,
  type ImportProgress,
  type ImportResult,
  type ImportableSession,
  type ProjectCandidate,
  type ToolsReport,
} from "./protocol.js";

const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
/** The wizard's place while it is open; a project switch may reload the page under it. */
export const FLOW_STORAGE_KEY = "tau.onboarding.flow.v1";

/** What a backend kit's `status` (and, where that lacks the login, its `probe`) told us about its program. */
export interface AgentStatus {
  installed?: boolean;
  version?: string;
  account?: string;
  /** Absent when the kit does not say. */
  signedIn?: boolean;
  /** The program is older than its kit speaks to; `command` updates it. */
  update?: { command?: string };
  /** The kit did not answer. */
  error?: string;
}

export interface FlowState {
  step: 0 | 1 | 2;
  tools?: ToolsReport;
  /** By runtime backend kind. */
  agents: Readonly<Record<string, AgentStatus>>;
  discovery?: Discovery;
  discoverError?: string;
  /** `undefined` until the user changes it: the default applies. */
  projects?: readonly string[];
  sessions?: readonly string[];
  /** Folders this run added to Tau. */
  added: readonly string[];
  /** Folders still to open; opening one may reload the page, so the rest wait here. */
  pending?: readonly string[];
  busy?: "projects" | "import";
  progress?: { done: number; total: number };
  error?: string;
  /** What runs in a terminal while the wizard stands aside for it. */
  terminal?: string;
  /** The agent row whose sign-in or command is open, so it is open again when the wizard comes back. */
  expanded?: string;
}

/** Clones of one repository, or one folder: what the projects step lists as a row or a group. */
export interface ProjectGroup {
  key: string;
  /** The remote's `owner/name`, else the folder's name. */
  label: string;
  projects: ProjectCandidate[];
  sources: ProjectCandidate["sources"];
  threadCount: number;
  lastActiveAt: number;
}

/**
 * T3 Code's grouping: clones of one remote share a group, a repository
 * without one is a group of its own, newest activity first; folders that are
 * not repositories come apart, to be folded away.
 */
export function groupProjects(candidates: readonly ProjectCandidate[]): { repositories: ProjectGroup[]; other: ProjectCandidate[] } {
  const groups = new Map<string, ProjectGroup>();
  const other: ProjectCandidate[] = [];
  for (const project of candidates) {
    if (!project.git) { other.push(project); continue; }
    const key = project.remote ? `remote:${project.remote.key}` : `path:${project.path}`;
    const group = groups.get(key) ?? { key, label: project.remote?.label ?? project.name, projects: [], sources: [], threadCount: 0, lastActiveAt: 0 };
    group.projects.push(project);
    group.threadCount += project.threadCount;
    group.lastActiveAt = Math.max(group.lastActiveAt, project.lastActiveAt);
    for (const source of project.sources) if (!group.sources.includes(source)) group.sources.push(source);
    groups.set(key, group);
  }
  const repositories = [...groups.values()].sort((left, right) => right.lastActiveAt - left.lastActiveAt || left.label.localeCompare(right.label));
  return { repositories, other };
}

/** T3 Code's default: repositories active in the last 30 days with at least three conversations. */
export function defaultProjects(candidates: readonly ProjectCandidate[], now: number): string[] {
  return candidates.filter((project) => project.git && project.threadCount >= 3 && now - project.lastActiveAt <= RECENT_MS).map((project) => project.path);
}

/** Recent conversations of the folders that are projects in Tau. */
export function defaultSessions(sessions: readonly ImportableSession[], projects: ReadonlySet<string>, now: number): string[] {
  return sessions.filter((session) => !session.imported && projects.has(session.cwd) && now - session.updatedAt <= RECENT_MS).map((session) => session.path);
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The line T3 Code shows when an import left something behind. */
export function importSummary(result: Pick<ImportResult, "imported" | "failed">): string {
  if (result.imported > 0 && result.failed > 0) return `Imported ${plural(result.imported, "thread")}. ${plural(result.failed, "thread")} could not be imported.`;
  if (result.failed > 0) return `${plural(result.failed, "thread")} could not be imported.`;
  return `Imported ${plural(result.imported, "thread")}.`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The kit that registered a backend kind, and the instance it names: `codex@work` → `tau.codex`, `work`. */
export function backendKit(kind: string): { extensionId: string; instance?: string } {
  const at = kind.indexOf("@");
  return at < 0 ? { extensionId: `tau.${kind}` } : { extensionId: `tau.${kind.slice(0, at)}`, instance: kind.slice(at + 1) };
}

interface StatusAnswer {
  path?: string;
  installed?: boolean;
  version?: string;
  signedIn?: boolean;
  account?: string | { kind?: string; email?: string; plan?: string };
  message?: string;
  unsupported?: boolean;
  updateCommand?: string;
  compatibility?: { status?: string; installCommand?: string };
}

function accountLabel(account: StatusAnswer["account"]): string | undefined {
  if (!account || typeof account === "string") return account || undefined;
  return account.email ?? account.plan ?? (account.kind === "apiKey" ? "API key" : "signed in");
}

/** Asks a backend's kit about its program; the fields the backend kits share are read, the rest ignored. */
async function agentStatus(host: (id: string) => HostExtensionClient, kind: string): Promise<AgentStatus> {
  const { extensionId, instance } = backendKit(kind);
  const client = host(extensionId);
  const input = instance ? { instance } : undefined;
  try {
    const status = (await client.invoke("status", input) ?? {}) as StatusAnswer;
    if (!status.path && status.installed !== true) return { installed: false };
    let version = status.version;
    let account = accountLabel(status.account);
    // A kit that tried and failed to learn the login says why in `message`.
    let signedIn = status.signedIn ?? (status.message ? false : undefined);
    if (signedIn === undefined) {
      // The Agent SDK runtime learns the login only by asking the program.
      const probe = await client.invoke("probe", input).catch(() => undefined) as { version?: string; account?: string } | undefined;
      if (probe) {
        version ??= probe.version;
        account ??= probe.account;
        signedIn = Boolean(probe.account);
      }
    }
    const broken = status.compatibility?.status === "broken";
    const updateCommand = broken ? status.compatibility?.installCommand ?? status.updateCommand : status.updateCommand;
    return {
      installed: true,
      ...(version ? { version } : {}),
      ...(account ? { account } : {}),
      ...(signedIn !== undefined ? { signedIn } : {}),
      ...(status.unsupported || broken ? { update: updateCommand ? { command: updateCommand } : {} } : {}),
    };
  } catch (error) {
    return { error: message(error) };
  }
}

/**
 * The wizard's state outside React, so a project switch that remounts the
 * workbench does not send the user back to the first step.
 */
export class WelcomeFlow {
  private state: FlowState = { step: 0, agents: {}, added: [] };
  private readonly listeners = new Set<() => void>();
  private started = false;
  private progressBase = 0;
  /** The backend kinds the agents step lists; asked again on `checkAgents`. */
  private kinds: readonly string[] = [];
  private readonly asked = new Set<string>();
  private generation = 0;

  constructor(
    private readonly host: HostExtensionClient,
    private readonly hostExtension: (id: string) => HostExtensionClient,
    private readonly storage: () => ClientStorage | undefined = () => undefined,
  ) {
    // A reload or a second activation takes over a wizard that is still open.
    this.resume();
    host.onEvent(IMPORT_PROGRESS_EVENT, (payload) => {
      const progress = payload as ImportProgress | undefined;
      if (this.state.busy === "import" && this.state.progress && typeof progress?.done === "number") this.set({ progress: { ...this.state.progress, done: this.progressBase + progress.done } });
    });
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = () => this.state;

  private set(patch: Partial<FlowState>): void {
    this.state = { ...this.state, ...patch };
    if (this.started) {
      const { step, added, pending, projects, sessions } = this.state;
      this.storage()?.set(FLOW_STORAGE_KEY, JSON.stringify({ step, added, pending, projects, sessions }));
    }
    for (const listener of this.listeners) listener();
  }

  /** Whether a wizard was open when this window last left it. */
  interrupted(): boolean {
    return Boolean(this.storage()?.get(FLOW_STORAGE_KEY));
  }

  private resume(): void {
    let saved: Partial<FlowState> | undefined;
    try { saved = JSON.parse(this.storage()?.get(FLOW_STORAGE_KEY) ?? "null") as Partial<FlowState> | undefined; } catch { saved = undefined; }
    if (!saved || typeof saved !== "object") return;
    const paths = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
    const pending = paths(saved.pending);
    // The last folder's switch reloaded the page: adding is done.
    const step = pending?.length === 0 ? 2 : saved.step === 1 || saved.step === 2 ? saved.step : 0;
    this.state = { step, agents: {}, added: paths(saved.added) ?? [], ...(pending?.length ? { pending } : {}), ...(paths(saved.projects) ? { projects: paths(saved.projects) } : {}), ...(paths(saved.sessions) ? { sessions: paths(saved.sessions) } : {}) };
  }

  /** Asks everything once per opening; `restart` begins at the first step again. */
  start(restart = false): void {
    if (restart) this.state = { step: 0, agents: {}, added: [] };
    if (this.started && !restart) return;
    this.started = true;
    // The agents step may have asked its backends already, in the same render.
    if (restart) this.checkAgents();
    else {
      this.askTools();
      this.askAgents(this.kinds);
    }
    this.discover();
  }

  /** Asks anew: the tools, and every backend the step listed so far. */
  checkAgents(): void {
    this.generation += 1;
    this.asked.clear();
    this.set({ tools: undefined, agents: {} });
    this.askTools();
    this.askAgents(this.kinds);
  }

  private askTools(): void {
    const generation = this.generation;
    void this.host.invoke("tools").then(
      (tools) => { if (generation === this.generation) this.set({ tools: tools as ToolsReport }); },
      (error) => { if (generation === this.generation) this.set({ error: message(error) }); },
    );
  }

  /** A backend kit's host half, for the sign-in rows the agents step opens in place. */
  kitHost(extensionId: string): HostExtensionClient {
    return this.hostExtension(extensionId);
  }

  /** Asks one backend again, after a sign-in on its row. */
  recheckAgent(kind: string): void {
    this.asked.delete(kind);
    this.askAgents(this.kinds);
  }

  /** Asks the backends not asked yet; runtimes that register later join the list. */
  askAgents(kinds: readonly string[]): void {
    this.kinds = kinds;
    const generation = this.generation;
    for (const kind of kinds) {
      if (this.asked.has(kind)) continue;
      this.asked.add(kind);
      void agentStatus(this.hostExtension, kind).then((status) => {
        if (generation === this.generation) this.set({ agents: { ...this.state.agents, [kind]: status } });
      });
    }
  }

  discover(): void {
    this.set({ discovery: undefined, discoverError: undefined });
    void this.host.invoke("discover").then(
      (discovery) => this.set({ discovery: discovery as Discovery }),
      (error) => this.set({ discoverError: message(error) }),
    );
  }

  expand(row: string | undefined): void {
    this.set({ expanded: row });
  }

  /** Asks for gh and glab again, after an install or a sign-in in a terminal. */
  checkTools(): void {
    this.set({ tools: undefined });
    this.askTools();
  }

  /** Marks the wizard as standing aside for a terminal; `undefined` when it is back. */
  setTerminal(label: string | undefined): void {
    this.set({ terminal: label });
  }

  goTo(step: FlowState["step"]): void {
    if (!this.state.busy) this.set({ step, error: undefined });
  }

  select(kind: "projects" | "sessions", paths: readonly string[]): void {
    this.set({ [kind]: [...new Set(paths)] });
  }

  /** Opens each folder as a project, the way the sidebar does; the last one stays open. */
  async addProjects(actions: WorkbenchActions, paths: readonly string[]): Promise<void> {
    if (this.state.busy) return;
    this.set({ busy: "projects", error: undefined, pending: paths });
    const added: string[] = [...this.state.added];
    const failed: string[] = [];
    for (const [index, path] of paths.entries()) {
      try {
        const ref = await this.host.invoke("project-ref", { path }) as { workspaceId: string };
        // Written before the switch: if it reloads the page, the rest resumes from here.
        this.set({ added: [...added, path], pending: paths.slice(index + 1) });
        if (await actions.openWorkspace(ref.workspaceId)) added.push(path);
        else failed.push(path);
      } catch {
        failed.push(path);
      }
    }
    this.set({ busy: undefined, added, pending: undefined, ...(failed.length ? { error: `${plural(failed.length, "folder")} could not be added.` } : { step: 2 }) });
  }

  /** Imports per source and answers with what to tell the user; nothing is left out silently. */
  async importSessions(actions: WorkbenchActions, sessions: readonly ImportableSession[]): Promise<ImportResult> {
    const total: ImportResult = { imported: 0, skipped: 0, failed: 0 };
    if (this.state.busy) return total;
    this.progressBase = 0;
    this.set({ busy: "import", progress: { done: 0, total: sessions.length }, error: undefined });
    for (const { source } of SESSION_SOURCES) {
      const paths = sessions.filter((session) => session.source === source).map((session) => session.path);
      if (paths.length === 0) continue;
      try {
        const result = await this.host.invoke("import-sessions", { source, paths }) as ImportResult;
        total.imported += result.imported;
        total.skipped += result.skipped;
        total.failed += result.failed;
        const update = result.update as HostActionResult["updates"][number] | undefined;
        if (update) actions.applyHostResult({ version: update.version, updates: [update] });
      } catch {
        total.failed += paths.length;
      }
      this.progressBase += paths.length;
    }
    this.set({ busy: undefined, progress: undefined, sessions: undefined, ...(total.failed ? { error: importSummary(total) } : {}) });
    // What is in Tau now, without emptying the list while it is asked.
    void this.host.invoke("discover").then((discovery) => this.set({ discovery: discovery as Discovery }), () => undefined);
    return total;
  }

  /** Remembers that setup ran, so it opens by itself no more; `/welcome` starts it afresh. */
  finish(): Promise<unknown> {
    this.started = false;
    this.generation += 1;
    this.asked.clear();
    this.storage()?.remove(FLOW_STORAGE_KEY);
    this.state = { step: 0, agents: {}, added: [] };
    return this.host.invoke("complete").catch(() => undefined);
  }
}
