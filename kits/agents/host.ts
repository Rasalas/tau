import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  HostCommandError,
  PARENT_LINK_ENTRY,
  readPersistedJson,
  writePersistedJson,
  type HostExtension,
  type HostExtensionContext,
  type HostMcpTool,
  type RuntimeSessionInfo,
} from "tau/host-extension";
import {
  AGENTS_HOST_EXTENSION_ID,
  AGENTS_STATE_EVENT,
  AGENT_CHILD_ENTRY,
  AGENT_PERSONA_FIELD,
  CHOOSE_MACHINE_COMMAND,
  MACHINES_KIT_ID,
  MACHINE_SETTING,
  MAX_AGENT_DEPTH,
  isBusyStatus,
  tauToolName,
  type AgentMachinesView,
  type AgentSendMode,
  type AgentThreadLink,
  type ChooseMachineAnswer,
  type AgentWorkspace,
  type AgentWorkspaceMode,
  type AgentDefinitionsState,
} from "./protocol.js";
import { AgentDefinitionReader, findAgentDefinition, summarize, type AgentDefinition } from "./definitions.js";
import {
  definitionsSection,
  firstMessageWithPersona,
  personaFromEntries,
  personaOf,
  personaSection,
  personaTools,
  sameTools,
  type AgentPersona,
} from "./persona.js";
import { DEFAULT_AGENT_PRIORITY, priorityPrefix, readAgentPriority, type AgentPriority } from "./priority.js";
import { RemoteChildren, resolveMachine, type MachineChoice, type MachineSource } from "./remote.js";
import { remoteThreadsClient } from "../remote-work/threads-client.js";
// Worktrees are Workspace Kit's, in every kit that needs one: this is the one
// leaf module it lends, and nothing else of that kit is reachable from here.
import {
  applyAgentWorktree,
  createAgentWorktree,
  readAgentWorktreeChanges,
  removeAgentWorktree,
  runAgentGit,
  type AgentGitRunner,
} from "../workspace/agent-worktrees.js";
import {
  AgentThreadBook,
  decodeClientRequestId,
  decodeSendRequest,
  decodeSpawnRequest,
  decodeThreadId,
  decodeTimeout,
  parseModel,
  readMaxRunningAgents,
  type ThreadLiveness,
} from "./threads.js";

/** A first prompt that never reaches its thread would leave it "running" forever. */
const SPAWN_ACCEPT_GRACE_MS = 60_000;

const RESULT_LIMIT = 2_000;

/** Panel rows only need a line; the tools get the full excerpt. */
const PANEL_RESULT_LIMIT = 240;

/** How much of each finished child's answer the message that wakes its parent carries. */
const WAKE_RESULT_LIMIT = 1_500;

/** A wake the parent refused (it was starting a turn) is tried again after this. */
const WAKE_RETRY_MS = 2_000;

/** Retry keys a thread's tools remember; the oldest goes first. */
const MAX_REMEMBERED_REQUESTS = 500;

/**
 * The message a parent gets when children it was not waiting for finished,
 * the way T3's orchestrator follows a delegated task up with its result.
 */
export function wakeMessage(children: ReadonlyArray<{ threadId: string; title: string; status: string; answer?: string; error?: string; machine?: string }>): string {
  const head = children.length === 1
    ? "A thread you started has finished."
    : `${children.length} threads you started have finished.`;
  const parts = children.map((child) => {
    const detail = child.error ?? (child.answer ? truncate(child.answer, WAKE_RESULT_LIMIT) : "It gave no answer.");
    return `— "${child.title}"${child.machine ? ` on ${child.machine}` : ""} (threadId ${child.threadId}): ${child.status}\n${detail}`;
  });
  return [`[Tau] ${head}`, ...parts, "Continue with this, or read more with tau_get_thread_status."].join("\n\n");
}

const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};

/** IPC input is untrusted, here as everywhere else. */
const requireText = (input: unknown, field: string): string => {
  const value = record(input)[field];
  if (typeof value !== "string" || !value.trim()) throw new HostCommandError(`This command needs "${field}".`);
  return value.trim();
};
const requireThreadId = (input: unknown): string => requireText(input, "threadId");

/** Access Kit's command for narrowing one thread; it names this kit as a caller. */
const ACCESS_KIT_ID = "tau.access";
const ACCESS_THREAD_LEVEL_COMMAND = "thread-level";

/**
 * How many children of one thread may run at a time is the user's setting, so
 * it stays in their own `~/.tau`. The kit only ever reads it; no instance,
 * least of all a dev one, writes here.
 */
export function agentsSettingsPath(home = homedir()): string {
  return join(home, ".tau", "agents.json");
}

/**
 * The kit's own index of who spawned what, in the state folder the host gives
 * it (`services.stateDir`). The session files stay the durable record; this
 * file is what lets the navigator hide fifty agent threads on the first paint
 * after a restart, without opening a single session to find out.
 */
export function agentsLinksPath(stateDir: string): string {
  return join(stateDir, "agents-links.json");
}

/** Where the links lived before they were a kit's own state; read once, then left alone. */
export function legacyAgentsLinksPath(home = homedir()): string {
  return join(home, ".tau", "agents-links.json");
}

/** v2 added `startedAt`/`endedAt`, so a restored agent still shows how long it ran. */
const LINKS_VERSION = 2;

/** A started agent on another machine, as the index file keeps it: its handle and its link there. */
export interface StoredRemoteLink {
  id: string;
  machine: { id: string; name: string; link: string };
}

/**
 * A started agent, as the index file keeps it; a queued one has no thread to
 * key on. One on another machine has no thread here: it carries `remote`, and
 * an older Tau, which needs a `threadId`, skips it.
 */
export type StoredAgentLink =
  Pick<AgentThreadLink, "parentThreadId" | "depth" | "spawnedAt" | "projectPath" | "title" | "spawnedBy" | "startedAt" | "endedAt" | "agent" | "turn">
  & ({ threadId: string; remote?: undefined } | { threadId?: undefined; remote: StoredRemoteLink });

function decodeRemote(value: unknown): StoredRemoteLink | undefined {
  const item = record(value);
  const machine = record(item.machine);
  if (typeof item.id !== "string" || typeof machine.id !== "string" || typeof machine.name !== "string" || typeof machine.link !== "string") return undefined;
  return { id: item.id, machine: { id: machine.id, name: machine.name, link: machine.link } };
}

/** A v1 file simply has no times; every other field reads the same. */
export function decodeStoredLinks(value: unknown): StoredAgentLink[] {
  const links = record(value).links;
  if (!Array.isArray(links)) return [];
  return links.flatMap((entry) => {
    const item = record(entry);
    const remote = typeof item.threadId === "string" ? undefined : decodeRemote(item.remote);
    if ((typeof item.threadId !== "string" && !remote) || typeof item.parentThreadId !== "string") return [];
    if (item.threadId === item.parentThreadId) return [];
    return [{
      ...(remote ? { remote } : { threadId: item.threadId as string }),
      parentThreadId: item.parentThreadId,
      depth: typeof item.depth === "number" ? item.depth : 1,
      spawnedAt: typeof item.spawnedAt === "number" ? item.spawnedAt : 0,
      projectPath: typeof item.projectPath === "string" ? item.projectPath : "",
      title: typeof item.title === "string" ? item.title : "Sub-agent",
      spawnedBy: typeof item.spawnedBy === "string" ? item.spawnedBy : "tau_spawn_thread",
      ...(typeof item.startedAt === "number" ? { startedAt: item.startedAt } : {}),
      ...(typeof item.endedAt === "number" ? { endedAt: item.endedAt } : {}),
      ...(typeof item.agent === "string" ? { agent: item.agent } : {}),
      ...(typeof item.turn === "number" ? { turn: item.turn } : {}),
    }];
  });
}

export async function readAgentLinks(path: string): Promise<StoredAgentLink[]> {
  const read = await readPersistedJson(path, {
    expectedVersion: LINKS_VERSION,
    decode: (value) => decodeStoredLinks(value),
  });
  return read?.data ?? [];
}

export function writeAgentLinks(links: readonly StoredAgentLink[], path: string): Promise<void> {
  return writePersistedJson(path, LINKS_VERSION, { links: [...links] });
}

/**
 * The links of the run before this file moved into the kit's state folder.
 * Read once, when the new file does not exist yet; the old one stays where it
 * is, so an older Tau beside this one still finds it.
 */
export async function readAgentLinksWithMigration(path: string, legacy = legacyAgentsLinksPath()): Promise<StoredAgentLink[]> {
  const links = await readAgentLinks(path);
  if (links.length > 0 || existsSync(path) || !existsSync(legacy)) return links;
  const inherited = await readAgentLinks(legacy);
  if (inherited.length > 0) await writeAgentLinks(inherited, path).catch(() => undefined);
  return inherited;
}

/** The key under which `services.settings()` answers where sub-agents run. */
export function machineSetting(values: Record<string, string> | undefined): string | undefined {
  const value = values?.[MACHINE_SETTING]?.trim();
  return value || undefined;
}

export interface AgentsSettings {
  /** How many children of one thread may run at a time. */
  maxRunning: number;
  /** How hard a sub-agent's commands yield to the user's work. */
  priority: AgentPriority;
}

/** The user's `~/.tau/agents.json`; a bad file is not an error. */
export async function readAgentsSettings(path = agentsSettingsPath()): Promise<AgentsSettings> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")) as unknown; } catch { value = undefined; }
  return { maxRunning: readMaxRunningAgents(value), priority: readAgentPriority(value) };
}

/** A title the panel can show before the thread has said anything. */
export function titleFromPrompt(prompt: string): string {
  const line = prompt.replace(/\s+/gu, " ").trim();
  const sentence = line.split(/(?<=[.!?])\s/u)[0] ?? line;
  const text = sentence.length > 60 ? `${sentence.slice(0, 57)}…` : sentence;
  return text || "Sub-agent";
}

/** Links a session file carries, as `beforeOpen` reads them back after a restart. */
export function linksFromEntries(sessionId: string, entries: readonly unknown[]): Array<Omit<AgentThreadLink, "status">> {
  const links: Array<Omit<AgentThreadLink, "status">> = [];
  for (const entry of entries) {
    const item = record(entry);
    if (item.type !== "custom") continue;
    const data = record(item.data);
    const depth = typeof data.depth === "number" ? data.depth : 1;
    const spawnedBy = typeof data.spawnedBy === "string" ? data.spawnedBy : "tau_spawn_thread";
    const spawnedAt = typeof data.spawnedAt === "number" ? data.spawnedAt : 0;
    const projectPath = typeof data.projectPath === "string" ? data.projectPath : "";
    const title = typeof data.title === "string" ? data.title : "Sub-agent";
    const common = {
      spawnedBy, spawnedAt, projectPath, depth, title,
      ...(typeof data.agent === "string" ? { agent: data.agent } : {}),
      ...(typeof data.turn === "number" ? { turn: data.turn } : {}),
    };
    if (item.customType === PARENT_LINK_ENTRY && typeof data.parentThreadId === "string") {
      links.push({ ...common, id: sessionId, threadId: sessionId, parentThreadId: data.parentThreadId });
    } else if (item.customType === AGENT_CHILD_ENTRY && typeof data.threadId === "string") {
      links.push({ ...common, id: data.threadId, threadId: data.threadId, parentThreadId: sessionId });
    }
  }
  return links;
}

function isUserPrompt(entry: unknown): boolean {
  const item = record(entry);
  return item.type === "message" && record(item.message).role === "user";
}

/** `edit src/a.ts`, `bash npm test`: a tool and what it worked on, for the panel's progress line. */
export function toolLine(tool: { name: string; args?: unknown }): string {
  const name = tauToolName(tool.name);
  const args = record(tool.args);
  const target = [args.path, args.file_path, args.command, args.pattern, args.query, args.url]
    .find((value): value is string => typeof value === "string" && value.trim() !== "");
  const line = target ? `${name} ${target.replace(/\s+/gu, " ").trim()}` : name;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function toolResult(value: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Agents Kit's host entry. A sub-agent is an ordinary Tau thread in the same
 * project with its own runtime and session file (ADR 0013); this kit only
 * gives every runtime the tools to start one, watch it and read its answer.
 */
export function createAgentsHostExtension(options: {
  /** The user's `~/.tau/agents.json`; tests point this elsewhere. */
  settingsPath?: string;
  /** The links file; `services.stateDir` names it otherwise. */
  linksPath?: string;
  /** The Git runner the child worktrees use; tests replace it. */
  runGit?: AgentGitRunner;
  /** How often a child on another machine is looked at; tests shorten it. */
  remotePollMs?: number;
} = {}): HostExtension {
  const definitionReader = new AgentDefinitionReader();
  return {
    id: AGENTS_HOST_EXTENSION_ID,
    name: "Agents",
    permissions: ["workspace:read", "sessions", "runtime:extend", "process", "machines"],
    async activate(context: HostExtensionContext) {
      const { services } = context;
      const linksPath = options.linksPath ?? agentsLinksPath(services.stateDir);
      const book: AgentThreadBook = new AgentThreadBook((threadId) => {
        const thread = services.thread(threadId);
        return thread ? { streaming: thread.isStreaming(), idle: thread.isIdle() } : undefined;
      }, (id): ThreadLiveness | undefined => remote.liveness(id));
      const waiters = new Map<string, Set<() => void>>();
      /** Turns a tool gave each child that have not ended yet; the parent hears once none are left. */
      const expecting = new Map<string, number>();
      const expect = (id: string) => { expecting.set(id, (expecting.get(id) ?? 0) + 1); };
      /** Children that finished while nobody waited for them, by parent, until the parent hears. */
      const unreported = new Map<string, Set<string>>();
      /** Calls made with a `clientRequestId`, by thread and tool, so a retry repeats nothing. */
      const requests = new Map<string, Promise<unknown>>();
      const once = <T>(threadId: string, tool: string, clientRequestId: string | undefined, work: () => Promise<T>): Promise<T> => {
        if (!clientRequestId) return work();
        const key = `${threadId}\u0000${tool}\u0000${clientRequestId}`;
        const known = requests.get(key);
        if (known) return known as Promise<T>;
        const running = work();
        requests.set(key, running);
        // A call that did nothing may be tried again under the same key.
        running.catch(() => { requests.delete(key); });
        if (requests.size > MAX_REMEMBERED_REQUESTS) requests.delete(requests.keys().next().value!);
        return running;
      };
      let publishing: NodeJS.Timeout | undefined;
      // Fifty agents produce bursts of turn events; the panel only needs the
      // state the burst settled on.
      const publish = () => {
        if (publishing) return;
        publishing = setTimeout(() => { publishing = undefined; context.emit(AGENTS_STATE_EVENT, book.state()); }, 30);
        publishing.unref?.();
      };

      let saving: NodeJS.Timeout | undefined;
      const save = () => {
        if (saving) return;
        saving = setTimeout(() => {
          saving = undefined;
          const links = book.state().links.flatMap((link): StoredAgentLink[] => link.threadId || link.machine?.link ? [{
            ...(link.threadId ? { threadId: link.threadId } : { remote: { id: link.id, machine: { id: link.machine!.id, name: link.machine!.name, link: link.machine!.link! } } }),
            parentThreadId: link.parentThreadId,
            depth: link.depth,
            spawnedAt: link.spawnedAt,
            projectPath: link.projectPath,
            title: link.title,
            spawnedBy: link.spawnedBy,
            ...(link.startedAt ? { startedAt: link.startedAt } : {}),
            ...(link.endedAt ? { endedAt: link.endedAt } : {}),
            ...(link.agent ? { agent: link.agent } : {}),
            ...(link.turn ? { turn: link.turn } : {}),
          }] : []);
          void writeAgentLinks(links, linksPath)
            .catch((error: unknown) => services.log("agents.links-write-failed", error instanceof Error ? error.message : String(error)));
        }, 50);
        saving.unref?.();
      };

      const wake = (id: string) => {
        for (const waiter of waiters.get(id) ?? []) waiter();
      };
      const changed = (idOrThreadId: string, moved: boolean) => {
        const id = book.linkFor(idOrThreadId)?.id;
        if (id) wake(id);
        if (moved) publish();
      };

      const lastAssistantMessage = async (threadId: string | undefined): Promise<string | undefined> => {
        const thread = threadId ? services.thread(threadId) : undefined;
        if (!thread) return undefined;
        const messages = await thread.transcript();
        const text = [...messages].reverse().find((message) => message.role === "assistant" && message.text)?.text;
        return text ? truncate(text, RESULT_LIMIT) : undefined;
      };
      /** A child's latest answer: its transcript here, or what its machine last sent. */
      const answerOf = async (link: AgentThreadLink): Promise<string | undefined> => {
        const there = link.machine ? remote.answer(link.id) : undefined;
        return (there ? truncate(there, RESULT_LIMIT) : await lastAssistantMessage(link.threadId)) ?? link.result;
      };

      // Children on other machines: Remote Work's thread service, followed into the same book.
      const remote: RemoteChildren = new RemoteChildren({
        service: remoteThreadsClient(context.invokeHostExtension),
        book,
        machines: () => services.machines,
        changed: (id, moved) => changed(id, moved),
        ended: (id, outcome) => childEnded(id, outcome),
        save: () => save(),
        log: (label, detail) => services.log(label, detail),
        ...(options.remotePollMs ? { pollMs: options.remotePollMs } : {}),
      });

      const statusOf = async (id: string) => {
        const facts = book.factsFor(id);
        const link = book.linkFor(id);
        const message = link ? await answerOf(link) : undefined;
        const workspace = link ? await readChanges(link) : undefined;
        if (link && workspace && JSON.stringify(workspace) !== JSON.stringify(link.workspace)) {
          changed(link.id, book.noteWorkspace(link.id, workspace));
        }
        return {
          threadId: link?.threadId ?? id,
          ...(link?.machine ? { machine: link.machine.name, ...(link.machine.offline ? { machineOffline: true } : {}) } : {}),
          ...(workspace?.mode === "worktree" ? {
            workspace: {
              branch: workspace.branch,
              path: workspace.path,
              ...(workspace.changes ? { changes: workspace.changes } : {}),
              ...(workspace.settled ? { settled: workspace.settled } : {}),
            },
          } : {}),
          ...(link?.title ? { title: link.title } : {}),
          status: link?.status ?? "idle",
          turns: facts.turns,
          ...(message ? { lastAssistantMessage: message } : {}),
          ...(facts.pendingToolPrompt ? { pendingToolPrompt: facts.pendingToolPrompt } : {}),
          ...(facts.error ? { error: facts.error } : {}),
        };
      };

      /** A child of this thread, refused by name when it is anything else. */
      const requireChild = (parentThreadId: string, handle: string): AgentThreadLink => {
        const link = book.linkFor(handle);
        if (!link || link.parentThreadId !== parentThreadId) {
          throw new Error(`${handle} is not a thread this one spawned. Use tau_list_threads to see them.`);
        }
        return link;
      };

      /** A project the host already knows; a sub-agent cannot open a new folder. */
      const resolveProject = async (requested: string | undefined, parentCwd: string): Promise<string> => {
        if (!requested || requested === parentCwd) return parentCwd;
        const known = await services.sessions.list();
        if (!known.some((session) => session.cwd === requested)) {
          throw new Error(`${requested} is not a project this host has open. Leave projectPath out to use this thread's project.`);
        }
        return requested;
      };

      /** The parent's prompts so far, which is the turn the thread header shows. */
      const promptCount = (threadId: string): number | undefined => {
        try {
          return services.thread(threadId)?.entries().filter(isUserPrompt).length;
        } catch {
          return undefined;
        }
      };

      /** What both session files record about a link, minus who is who. */
      const linkData = (link: Omit<AgentThreadLink, "status">) => ({
        version: 1,
        spawnedBy: link.spawnedBy,
        spawnedAt: link.spawnedAt,
        projectPath: link.projectPath,
        depth: link.depth,
        title: link.title,
        ...(link.agent ? { agent: link.agent } : {}),
        ...(link.turn ? { turn: link.turn } : {}),
      });

      const remember = (link: AgentThreadLink) => {
        // The child's half is written by `sessions.start` before its first
        // prompt, so the thread index finds it without opening the thread; the
        // parent's half is appended here, and `beforeOpen` reads either back.
        try {
          services.thread(link.parentThreadId)?.appendEntry(AGENT_CHILD_ENTRY, { ...linkData(link), threadId: link.threadId });
        } catch (error) {
          // A parent on another runtime keeps no journal; the links file is its record.
          services.log("agents.parent-entry-skipped", error instanceof Error ? error.message : String(error));
        }
        save();
      };

      const prompts = new Map<string, string>();
      /** The definition each queued agent was spawned with, until its thread is built. */
      const definitions = new Map<string, AgentDefinition>();
      /** What each queued agent asked for, until its thread is built. */
      const wanted = new Map<string, AgentWorkspaceMode>();
      const runGit: AgentGitRunner = (cwd, args, gitOptions) => {
        services.noteSubprocess();
        return (options.runGit ?? runAgentGit)(cwd, args, gitOptions);
      };

      /** A project is a repository when Git answers for it; anything else shares. */
      const isRepository = async (project: string): Promise<boolean> =>
        runGit(project, ["rev-parse", "--is-inside-work-tree"]).then((out) => out.trim() === "true").catch(() => false);

      /**
       * The checkout a child works in. It starts from the parent's HEAD and
       * its uncommitted work as they are now, so the child continues the work
       * the parent is doing rather than the last commit.
       */
      const openWorktree = async (agent: AgentThreadLink): Promise<AgentWorkspace> => {
        const worktree = await createAgentWorktree({ parentCwd: agent.projectPath, agentId: agent.id, runGit });
        services.log("agents.worktree", `${worktree.branch} · ${worktree.withUncommitted ? "from HEAD and the parent's uncommitted work" : "from HEAD"}`);
        return { mode: "worktree", path: worktree.path, branch: worktree.branch };
      };

      /** What a child changed in its own checkout; absent for one that shares. */
      const readChanges = async (link: AgentThreadLink): Promise<AgentWorkspace | undefined> => {
        const workspace = link.workspace;
        // A worktree on another machine is read there; what came back says what changed.
        if (link.machine || !workspace || workspace.mode !== "worktree" || !workspace.branch || workspace.settled) return workspace;
        try {
          const changes = await readAgentWorktreeChanges({ path: workspace.path, branch: workspace.branch }, runGit);
          return { ...workspace, changes: { files: changes.files, added: changes.added, removed: changes.removed, commits: changes.commits, uncommitted: changes.uncommitted } };
        } catch {
          return workspace;
        }
      };

      /**
       * Takes one of the parent's slots for a queued agent, or reports that the
       * budget is full. It is deliberately synchronous: twenty `tau_spawn_thread`
       * calls arriving in one turn each claim their own slot before any of them
       * awaits, which is what lets the whole batch start together.
       */
      const claimSlot = (agentId: string): boolean => {
        const link = book.linkFor(agentId);
        if (!link || link.status !== "pending") return false;
        if (book.busyChildren(link.parentThreadId) >= book.runningBudget) return false;
        // Another machine's slots are its own: as many as it has cores.
        if (!remote.hasRoom(link.machine?.id)) return false;
        changed(agentId, book.noteStarting(agentId, Date.now()));
        return true;
      };

      /** Builds one agent's thread. Its slot is already claimed. */
      const startAgent = async (agent: AgentThreadLink): Promise<void> => {
        if (agent.machine) return startRemote(agent);
        let workspace: AgentWorkspace | undefined;
        try {
          // The worktree comes first: a thread that started in the parent's
          // checkout cannot be moved into one afterwards.
          if (wanted.get(agent.id) === "worktree") {
            workspace = await openWorktree(agent);
            changed(agent.id, book.noteWorkspace(agent.id, workspace));
          }
          const definition = definitions.get(agent.id);
          const prompt = prompts.get(agent.id) ?? agent.title;
          // Tau's own Pi extension puts a persona into the system prompt; a
          // runtime it cannot extend reads it at the head of the first message.
          const piRuntime = (definition?.runtime ?? "pi") === "pi";
          const started = await services.sessions.start({
            cwd: workspace?.path ?? agent.projectPath,
            prompt: definition && !piRuntime ? firstMessageWithPersona(definition, prompt) : prompt,
            title: agent.title,
            ...(agent.model ? { model: parseModel(agent.model) } : {}),
            ...(definition?.runtime ? { backend: definition.runtime } : {}),
            // Pi's tools are narrowed by this kit's runtime extension; another runtime narrows its own or refuses.
            ...(definition?.tools && !piRuntime ? { tools: definition.tools } : {}),
            parent: {
              threadId: agent.parentThreadId,
              details: { ...linkData(agent), ...(definition && piRuntime ? { [AGENT_PERSONA_FIELD]: personaOf(definition) } : {}) },
            },
          });
          prompts.delete(agent.id);
          changed(agent.id, book.noteStarted(agent.id, started.sessionId, Date.now()));
          remember(book.linkFor(agent.id)!);
          services.log("agents.started", `${started.sessionId.slice(0, 8)} · ${agent.title}`);
          const guard = setTimeout(() => {
            if (book.factsFor(agent.id).spawning) {
              changed(agent.id, book.noteError(agent.id, "The first prompt never reached this thread."));
            }
          }, SPAWN_ACCEPT_GRACE_MS);
          guard.unref?.();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // A thread that never started leaves no worktree behind.
          if (workspace?.branch) {
            await removeAgentWorktree({ parentCwd: agent.projectPath, worktree: { path: workspace.path, branch: workspace.branch }, runGit }).catch(() => undefined);
            changed(agent.id, book.noteWorkspace(agent.id, undefined));
          }
          changed(agent.id, book.noteError(agent.id, message));
          services.log("agents.start-failed", message);
        } finally {
          wanted.delete(agent.id);
          definitions.delete(agent.id);
        }
      };

      /**
       * Builds a child on another machine: Remote Work carries the parent's
       * state there (HEAD and its uncommitted work, as for a worktree here)
       * and starts an ordinary thread in it. The persona rides in the first
       * message, since that machine's Agents Kit never saw the definition.
       */
      const startRemote = async (agent: AgentThreadLink): Promise<void> => {
        const machine = agent.machine!;
        try {
          const definition = definitions.get(agent.id);
          const prompt = prompts.get(agent.id) ?? agent.title;
          await remote.start(agent.id, {
            machine: machine.id,
            cwd: agent.projectPath,
            prompt: definition ? firstMessageWithPersona(definition, prompt) : prompt,
            title: agent.title,
            ...(agent.model ? { model: parseModel(agent.model) } : {}),
            ...(definition?.runtime ? { backend: definition.runtime } : {}),
            parentThreadId: agent.parentThreadId,
            ...(definition ? { agent: definition.name } : {}),
            agentDepth: agent.depth,
          });
          prompts.delete(agent.id);
          services.log("agents.started-remote", `${agent.id.slice(0, 8)} → ${machine.name} · ${agent.title}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          changed(agent.id, book.noteError(agent.id, message));
          services.log("agents.start-failed", `${machine.name}: ${message}`);
        } finally {
          wanted.delete(agent.id);
          definitions.delete(agent.id);
        }
      };

      /**
       * Starts what freed slots allow, oldest first, and starts that whole batch
       * at once: a thread takes a moment to build, and waiting for one before
       * building the next is what kept agents trickling in one at a time. The
       * host bounds the real concurrency; the budget bounds how many run.
       */
      const pumps = new Map<string, Promise<void>>();
      const pump = (parentThreadId: string): Promise<void> => {
        const running = pumps.get(parentThreadId);
        if (running) return running;
        const work = (async () => {
          for (;;) {
            const waiting = book.startable(parentThreadId, (agent) => remote.hasRoom(agent.machine?.id));
            // What else runs on those machines is read before the batch claims their slots.
            for (const machine of new Set(waiting.flatMap((agent) => agent.machine ? [agent.machine.id] : []))) await remote.prepare(machine);
            const batch = book.startable(parentThreadId, (agent) => remote.hasRoom(agent.machine?.id)).filter((agent) => claimSlot(agent.id));
            if (batch.length === 0) return;
            await Promise.all(batch.map((agent) => startAgent(agent)));
          }
        })().finally(() => { pumps.delete(parentThreadId); });
        pumps.set(parentThreadId, work);
        return work;
      };

      /**
       * A thread's depth among sub-agents. One another machine started here as
       * a sub-agent carries the depth it had there, so the tree stops at the
       * same level on whichever machine it grows.
       */
      const depths = new Map<string, Promise<number>>();
      const depthOf = (threadId: string): Promise<number> => {
        const own = book.depthOf(threadId);
        if (own > 0) return Promise.resolve(own);
        let known = depths.get(threadId);
        if (!known) {
          known = remoteThreadsClient(context.invokeHostExtension).agentDepth(threadId).then((depth) => depth ?? 0, () => 0);
          depths.set(threadId, known);
        }
        return known;
      };

      /** Where a spawn runs: the tool's machine, the definition's, else the user's setting; this computer by default. */
      const chooseMachine = async (request: { machine?: string }, definition: AgentDefinition | undefined, projectPath: string, model: string | undefined): Promise<MachineChoice> => {
        let setting: string | undefined;
        if (!request.machine && !definition?.machine) {
          setting = machineSetting(await services.settings?.(projectPath).then((read) => read.values, () => undefined));
        }
        const source: MachineSource = request.machine ? "tool" : definition?.machine ? "definition" : "setting";
        return resolveMachine(request.machine ?? definition?.machine ?? setting, source, {
          machines: () => services.machines,
          auto: async () => {
            try {
              const answer = await context.invokeHostExtension(MACHINES_KIT_ID, CHOOSE_MACHINE_COMMAND, {
                purpose: "sub-agent", cwd: projectPath, ...(definition?.runtime ? { backend: definition.runtime } : {}), ...(model ? { model } : {}),
              }) as ChooseMachineAnswer | undefined;
              return answer && typeof answer.reason === "string" ? answer : undefined;
            } catch (error) {
              services.log("agents.auto-machine-unavailable", error instanceof Error ? error.message : String(error));
              return undefined;
            }
          },
        });
      };

      const spawn = async (parent: RuntimeSessionInfo, input: unknown, inheritedModel: string | undefined, spawnedBy = "tau_spawn_thread") => {
        const request = decodeSpawnRequest(input);
        const depth = await depthOf(parent.sessionId);
        if (depth + 1 > MAX_AGENT_DEPTH) throw new Error(`Sub-agents may nest ${MAX_AGENT_DEPTH} levels deep; do this work in this thread instead.`);
        const projectPath = await resolveProject(request.projectPath, parent.cwd);
        // An unknown or broken definition fails this spawn only; the others go on.
        const definition = request.agent ? findAgentDefinition(await definitionReader.read(projectPath), request.agent) : undefined;
        // The parent's model belongs to the parent's runtime; another one picks its own.
        const sameRuntime = (definition?.runtime ?? "pi") === "pi";
        const model = request.model ?? definition?.model ?? (sameRuntime ? inheritedModel : undefined);
        if (model) parseModel(model);
        const choice = await chooseMachine(request, definition, projectPath, model);
        const requested = request.workspace ?? definition?.workspace;
        const repository = await isRepository(projectPath);
        if (choice.machine) {
          const where = choice.machine.name;
          if (request.workspace === "shared") throw new Error(`A thread on ${where} works in a worktree there; "shared" only works on this computer.`);
          if (!repository) throw new Error(`Only a Git repository's state can go to ${where}; run this one here with machine "local".`);
          // Tau holds a persona to its tools and access in a runtime here; the machine there never saw the definition.
          if (definition?.tools || (definition?.access && definition.access !== "full")) {
            throw new Error(`The agent definition "${definition.name}" limits its tools or access, which ${where} cannot hold it to; run it here with machine "local".`);
          }
          await remote.prepare(choice.machine.id);
        }
        const id = randomUUID();
        prompts.set(id, request.prompt);
        if (definition) definitions.set(id, definition);
        // A child writes by default, and two writers in one checkout collide;
        // a project that is not a repository has nowhere else to go.
        const mode: AgentWorkspaceMode = choice.machine ? "worktree"
          : requested === "shared" || !repository ? "shared"
          : requested ?? "worktree";
        wanted.set(id, mode);
        // Only a tool's spawn wakes its parent; one the user started from the panel does not.
        if (spawnedBy === "tau_spawn_thread") expect(id);
        const turn = promptCount(parent.sessionId);
        book.add({
          id,
          parentThreadId: parent.sessionId,
          spawnedBy,
          spawnedAt: Date.now(),
          ...(turn ? { turn } : {}),
          projectPath,
          depth: depth + 1,
          title: request.title ?? titleFromPrompt(request.prompt),
          ...(definition ? { agent: definition.name } : {}),
          ...(model ? { model } : {}),
          ...(choice.machine ? { machine: { ...choice.machine, ...(choice.reason ? { reason: choice.reason } : {}) } } : {}),
        }, { queued: true });
        publish();
        // A slot free right now belongs to this call, so it comes back with a
        // real thread id; a spawn beyond the budget queues and returns at once.
        if (claimSlot(id)) await startAgent(book.linkFor(id)!);
        const link = book.linkFor(id)!;
        return {
          threadId: link.threadId ?? id,
          title: link.title,
          status: link.status,
          workspace: link.workspace?.mode ?? mode,
          ...(link.workspace?.branch && !link.machine ? { branch: link.workspace.branch } : {}),
          ...(link.machine ? { machine: link.machine.name } : {}),
          ...(choice.reason ? { machineChoice: choice.reason } : {}),
          ...(link.agent ? { agent: link.agent } : {}),
          ...(link.error ? { error: link.error } : {}),
        };
      };

      /**
       * The parent's decision about a child's worktree: take the work or throw
       * it away. Either way the worktree goes, because the child is done with
       * it; a failed apply keeps both, so nothing is lost to a collision.
       */
      const settleWorkspace = async (id: string, outcome: "applied" | "discarded"): Promise<{ detail: string; branch?: string }> => {
        const link = book.linkFor(id);
        const workspace = link?.workspace;
        if (link?.machine) {
          if (workspace?.settled) throw new Error(`Its changes were already ${workspace.settled}.`);
          if (isBusyStatus(link.status)) throw new Error("This thread is still working; wait for it before taking its changes.");
          if (!link.machine.link) throw new Error(`It never reached ${link.machine.name}; there is nothing to apply or discard.`);
          return settleRemote(link, outcome);
        }
        if (!link || !workspace || workspace.mode !== "worktree" || !workspace.branch) {
          throw new Error("This thread works in your own checkout; there is nothing to apply or discard.");
        }
        if (workspace.settled) throw new Error(`Its changes were already ${workspace.settled}.`);
        if (isBusyStatus(link.status)) throw new Error("This thread is still working; wait for it before taking its changes.");
        const worktree = { path: workspace.path, branch: workspace.branch };
        let detail = `Discarded ${workspace.branch}.`;
        if (outcome === "applied") {
          const applied = await applyAgentWorktree({ parentCwd: link.projectPath, worktree, runGit });
          detail = applied.detail;
        }
        await removeAgentWorktree({ parentCwd: link.projectPath, worktree, runGit });
        changed(id, book.noteWorkspace(id, { ...workspace, settled: outcome }));
        save();
        services.log(`agents.${outcome}`, `${workspace.branch} · ${detail}`);
        return { detail, branch: workspace.branch };
      };

      /** The same decision for a child on another machine: its work comes back as a branch here first. */
      const settleRemote = async (link: AgentThreadLink, outcome: "applied" | "discarded"): Promise<{ detail: string; branch?: string }> => {
        const where = link.machine!.name;
        if (link.machine!.offline) throw new Error(`${where} is offline; its work comes back once it is reachable again.`);
        const settled = await remote.settle(link.id, outcome === "applied" ? "apply" : "discard");
        const branch = settled.result?.state === "branch" ? settled.result.branch : undefined;
        if (settled.status !== "settled") {
          const applied = settled.applied;
          const files = applied?.files.length ? `: ${applied.files.join(", ")}` : "";
          throw new Error(applied?.state === "conflict"
            ? `Nothing was applied: ${branch ?? "its branch"} from ${where} conflicts with this checkout${files}. The branch stays for you to merge by hand.`
            : `Nothing was applied: ${applied?.detail ?? "the merge could not run"}${branch ? ` The branch ${branch} stays.` : ""}`);
        }
        const detail = settled.settled?.detail ?? (outcome === "applied" ? "Applied." : "Discarded.");
        services.log(`agents.${outcome}`, `${where} · ${detail}`);
        return { detail, ...(branch ? { branch } : {}) };
      };

      /** The parent read what this child did, so nothing wakes it for that any more. */
      const reported = (parentThreadId: string, id: string) => {
        const pending = unreported.get(parentThreadId);
        if (pending?.delete(id) && pending.size === 0) unreported.delete(parentThreadId);
      };

      /**
       * Tells a parent what finished while it was not waiting: one new message
       * once it is idle, as T3's orchestrator follows a delegated task up with
       * its result. A busy parent hears when its own turn ends.
       */
      /** Parents a wake is on its way to: the turn it starts ends with the next flush. */
      const waking = new Set<string>();
      const flushWakes = async (parentThreadId: string, afterTurn = false): Promise<void> => {
        const parent = services.thread(parentThreadId);
        if (afterTurn) await parent?.waitForIdle().catch(() => undefined);
        if (waking.has(parentThreadId) || (parent && (parent.isStreaming() || !parent.isIdle()))) return;
        const ids = [...(unreported.get(parentThreadId) ?? [])];
        unreported.delete(parentThreadId);
        const send = services.sessions.send;
        if (ids.length === 0 || !send) return;
        waking.add(parentThreadId);
        let sent = false;
        try {
          const children = (await Promise.all(ids.map(async (id) => {
            const link = book.linkFor(id);
            if (!link) return [];
            const answer = await answerOf(link);
            return [{
              threadId: link.threadId ?? link.id,
              title: link.title,
              status: link.status,
              ...(answer ? { answer } : {}),
              ...(link.error ? { error: link.error } : {}),
              ...(link.machine ? { machine: link.machine.name } : {}),
            }];
          }))).flat();
          if (children.length === 0) return;
          await send(parentThreadId, wakeMessage(children));
          sent = true;
          services.log("agents.parent-woken", `${parentThreadId.slice(0, 8)} · ${children.length}`);
        } catch (error) {
          // A prompt refused because the parent was starting a turn: those children wait for the next flush.
          const pending = unreported.get(parentThreadId) ?? new Set<string>();
          for (const id of ids) if (book.has(id)) pending.add(id);
          unreported.set(parentThreadId, pending);
          services.log("agents.wake-failed", `${parentThreadId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          waking.delete(parentThreadId);
        }
        // What finished while this wake was on its way, or what it could not deliver, goes once the parent is idle.
        if (unreported.has(parentThreadId)) {
          if (sent) void flushWakes(parentThreadId, true);
          else {
            const retry = setTimeout(() => { void flushWakes(parentThreadId, true); }, WAKE_RETRY_MS);
            retry.unref?.();
          }
        }
      };

      /** More work for a child: extends a queued one's first prompt, or reaches its thread in the mode asked for. */
      const sendTo = async (parentThreadId: string, input: unknown) => {
        const request = decodeSendRequest(input);
        const link = requireChild(parentThreadId, request.threadId);
        reported(parentThreadId, link.id);
        if (!link.threadId && !link.machine?.link) {
          if (link.status === "cancelled") throw new Error(`${link.title} was cancelled before it started; spawn a new thread instead.`);
          if (request.mode === "steer" || request.mode === "restart") {
            throw new Error(`${link.title} has not started yet; send with mode "queue" or "auto", or cancel it.`);
          }
          // Its first prompt has not left yet, so the message rides along with it.
          prompts.set(link.id, `${prompts.get(link.id) ?? link.title}\n\n${request.message}`);
          return { threadId: link.id, delivered: "with its first prompt", status: link.status };
        }
        // Past the queue, a child without a thread here is one on another machine.
        if (link.machine || !link.threadId) return sendRemote(parentThreadId, link, request.message, request.mode);
        const send = services.sessions.send;
        if (!send) throw new Error("This Tau cannot send to another thread; it needs extension API 1.11.0.");
        const thread = services.thread(link.threadId);
        const running = thread?.isStreaming() ?? false;
        if (request.mode === "steer" && !running) throw new Error(`${link.title} is not running; send with mode "auto" or "queue".`);
        let delivery: "prompt" | "steer" | "queue" = request.mode === "queue" ? "queue"
          : request.mode === "steer" || (request.mode === "auto" && running) ? "steer"
          : "prompt";
        // Counted before a restart stops the running turn, so that turn's end wakes nobody.
        if (delivery !== "steer") expect(link.id);
        else if (!expecting.has(link.id)) expecting.set(link.id, 1);
        if (request.mode === "restart" && running) {
          if (!services.sessions.abort) throw new Error("This Tau cannot stop another thread's turn; it needs extension API 1.11.0.");
          await services.sessions.abort(link.threadId);
          await services.thread(link.threadId)?.waitForIdle().catch(() => undefined);
        }
        changed(link.id, book.noteSent(link.id, delivery === "prompt"));
        try {
          await send(link.threadId, request.message, { delivery, from: parentThreadId });
        } catch (error) {
          // A runtime that cannot steer still takes the message after its turn.
          if (request.mode !== "auto" || delivery !== "steer") throw error;
          delivery = "queue";
          expect(link.id);
          await send(link.threadId, request.message, { delivery, from: parentThreadId });
        }
        const delivered = request.mode === "restart" ? "restarted" : delivery === "prompt" ? "started" : delivery === "steer" ? "steered" : "queued";
        return { threadId: link.threadId, delivered, status: book.linkFor(link.id)?.status ?? link.status };
      };

      /** `sendTo` for a child on another machine: the same modes, through its link there. */
      const sendRemote = async (parentThreadId: string, link: AgentThreadLink, message: string, mode: AgentSendMode) => {
        const where = link.machine!;
        if (!where.link) {
          if (mode === "steer" || mode === "restart") throw new Error(`${link.title} is still on its way to ${where.name}; send with mode "queue" or "auto".`);
          throw new Error(`${link.title} is still on its way to ${where.name}; send again once it runs there.`);
        }
        const running = remote.running(link.id);
        if (mode === "steer" && !running) throw new Error(`${link.title} is not running; send with mode "auto" or "queue".`);
        const delivery: "prompt" | "steer" | "queue" = mode === "queue" ? "queue"
          : mode === "steer" || (mode === "auto" && running) ? "steer"
          : "prompt";
        if (delivery !== "steer") expect(link.id);
        else if (!expecting.has(link.id)) expecting.set(link.id, 1);
        if (mode === "restart" && running) {
          await remote.abort(link.id);
          await remote.settleTurn(link.id, 15_000).catch(() => undefined);
        }
        changed(link.id, book.noteSent(link.id, delivery === "prompt"));
        await remote.send(link.id, message, delivery);
        const delivered = mode === "restart" ? "restarted" : delivery === "prompt" ? "started" : delivery === "steer" ? "steered" : "queued";
        return { threadId: link.id, machine: where.name, delivered, status: book.linkFor(link.id)?.status ?? link.status };
      };

      /** Stops a child: a queued one never starts, a running one ends its turn. A finished one stays as it is. */
      const cancelChild = async (parentThreadId: string, input: unknown) => {
        const link = requireChild(parentThreadId, decodeThreadId(input));
        const handle = link.threadId ?? link.id;
        expecting.delete(link.id);
        reported(parentThreadId, link.id);
        if (link.status === "pending") {
          prompts.delete(link.id);
          definitions.delete(link.id);
          wanted.delete(link.id);
          changed(link.id, book.noteCancelled(link.id, Date.now()));
          return { threadId: handle, status: "cancelled", cancelled: true };
        }
        if (link.machine?.link && isBusyStatus(link.status)) {
          changed(link.id, book.noteCancelled(link.id, Date.now()));
          await remote.abort(link.id);
          void pump(parentThreadId);
          return { threadId: handle, status: book.linkFor(link.id)?.status ?? "cancelled", cancelled: true };
        }
        if (!isBusyStatus(link.status) || !link.threadId) return { threadId: handle, status: link.status, cancelled: false };
        if (!services.sessions.abort) throw new Error("This Tau cannot stop another thread's turn; it needs extension API 1.11.0.");
        changed(link.id, book.noteCancelled(link.id, Date.now()));
        await services.sessions.abort(link.threadId);
        void pump(parentThreadId);
        return { threadId: handle, status: book.linkFor(link.id)?.status ?? "cancelled", cancelled: true };
      };

      /** Resolves when the agent's turn ended, it asked the user something, or it failed. */
      const waitFor = (id: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<"settled" | "timeout"> => {
        const settled = () => {
          const facts = book.factsFor(id);
          const status = book.linkFor(id)?.status;
          return facts.error !== undefined
            || facts.pendingToolPrompt !== undefined
            // Its machine went away: the thread may go on there, but nothing here learns when.
            || book.linkFor(id)?.machine?.offline === true
            || (status !== undefined && status !== "running" && status !== "pending");
        };
        if (settled()) return Promise.resolve("settled");
        return new Promise((resolve) => {
          const own = waiters.get(id) ?? new Set<() => void>();
          waiters.set(id, own);
          const finish = (outcome: "settled" | "timeout") => {
            own.delete(check);
            if (own.size === 0) waiters.delete(id);
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve(outcome);
          };
          const check = () => { if (settled()) finish("settled"); };
          const onAbort = () => finish("timeout");
          const timer = setTimeout(() => finish("timeout"), timeoutMs);
          own.add(check);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      };

      /**
       * The tools of one thread: Pi registers them in its runtime, and every
       * other runtime reaches the same ones over the host's MCP endpoint.
       */
      const agentTools = (session: RuntimeSessionInfo): HostMcpTool[] => {
        const threadId = session.sessionId;
        return [
          {
            name: "tau_spawn_thread",
            label: "Spawn thread",
            description: [
              "Start a new Tau thread in this project that works on a task on its own.",
              "It appears in the Agents panel beside this conversation, has its own agent and its own transcript, and runs in the background.",
              "By default it gets its own Git worktree, branched from this thread's current state, so it can write without colliding with this checkout; take its work back with tau_apply_thread_changes.",
              `Returns immediately. Spawns beyond the running budget are queued with status "pending" and start as slots free; sub-agents may nest ${MAX_AGENT_DEPTH} levels deep.`,
              "Read an answer with tau_wait_for_thread or tau_get_thread_status; when it finishes while you are not waiting for it, this thread gets its answer as a new message.",
              "Pass agent to start it from one of the project's agent definitions in .tau/agents/: its instructions, model, runtime, tools and workspace apply.",
              "Pass machine to run it on another computer this one's agents reach (by name, like \"rex\"): it gets a worktree there with this thread's state, and tau_apply_thread_changes brings its work back here as a branch and merges it. Each machine runs as many at once as it has cores; the rest queue.",
            ].join(" "),
            promptSnippet: "tau_spawn_thread: delegate a task to a new background thread in this project",
            parameters: Type.Object({
              prompt: Type.String({ description: "The first message for the new thread. Say what it should do and what to report back." }),
              title: Type.Optional(Type.String({ description: "Title for the Agents panel; derived from the prompt when left out." })),
              model: Type.Optional(Type.String({ description: "Model as provider/model-id; this thread's model when left out." })),
              projectPath: Type.Optional(Type.String({ description: "A project this host already has open; this thread's project when left out." })),
              workspace: Type.Optional(Type.String({
                description: 'Where it works: "worktree" for its own checkout branched from this thread\'s state (the default in a Git repository), or "shared" to write in this very checkout — only safe for a thread that reads.',
              })),
              agent: Type.Optional(Type.String({ description: "Name of an agent definition in this project's .tau/agents/; a plain thread when left out." })),
              machine: Type.Optional(Type.String({
                description: 'Where it runs: a machine\'s name or id, "local" for this computer, or "auto" to let Tau pick by load. The definition\'s machine, else the user\'s setting (this computer unless they chose otherwise), when left out.',
              })),
              clientRequestId: Type.Optional(Type.String({ description: "Your own id for this spawn; a retry with the same id returns the thread the first call started." })),
            }),
            // Over MCP there is no Pi context, and a model of another runtime is not one to inherit.
            execute: async (_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext | undefined) => {
              const inherited = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
              return toolResult(await once(threadId, "spawn", decodeClientRequestId(params), () => spawn(session, params, inherited)));
            },
          },
          {
            name: "tau_get_thread_status",
            label: "Thread status",
            description: "Report what a thread spawned from here is doing right now, and its latest answer.",
            parameters: Type.Object({
              threadId: Type.String({ description: "Thread id returned by tau_spawn_thread." }),
            }),
            execute: async (_toolCallId, params) => {
              const link = requireChild(threadId, decodeThreadId(params));
              const status = await statusOf(link.id);
              if (!isBusyStatus(status.status) && status.status !== "pending") reported(threadId, link.id);
              return toolResult(status);
            },
          },
          {
            name: "tau_wait_for_thread",
            label: "Wait for thread",
            description: [
              "Wait until a thread spawned from here finishes its current turn, then report its status and final answer.",
              "A queued thread is waited for as well: the wait covers the time it spends pending.",
              "It also returns early when that thread asks the user a question, which only the user can answer in that thread.",
              "For a thread with its own worktree the answer also carries its branch and what it changed there.",
            ].join(" "),
            parameters: Type.Object({
              threadId: Type.String({ description: "Thread id returned by tau_spawn_thread." }),
              timeoutMs: Type.Optional(Type.Number({ description: "How long to wait; 10 minutes by default, 30 minutes at most." })),
            }),
            execute: async (_toolCallId, params, signal) => {
              const handle = decodeThreadId(params);
              const link = requireChild(threadId, handle);
              const timeoutMs = decodeTimeout(params);
              const outcome = await waitFor(link.id, timeoutMs, signal);
              const status = await statusOf(link.id);
              if (!isBusyStatus(status.status) && status.status !== "pending") reported(threadId, link.id);
              return toolResult({ ...status, ...(outcome === "timeout" ? { timedOut: true } : {}) });
            },
          },
          {
            name: "tau_send_to_thread",
            label: "Send to thread",
            description: [
              "Send a thread spawned from here another message: a follow-up task, a correction, or what it asked for.",
              'mode "auto" (the default) starts it when it is idle and steers its running turn, queueing when it cannot steer;',
              '"queue" waits for its running turn to end; "steer" joins the running turn now; "restart" stops the running turn and starts over with this message.',
              "When the turn ends and you are not waiting for it, this thread gets its answer as a new message.",
            ].join(" "),
            parameters: Type.Object({
              threadId: Type.String({ description: "Thread id returned by tau_spawn_thread." }),
              message: Type.String({ description: "What the thread should do or know next." }),
              mode: Type.Optional(Type.String({ description: '"auto", "queue", "steer" or "restart"; "auto" when left out.' })),
              clientRequestId: Type.Optional(Type.String({ description: "Your own id for this message; a retry with the same id sends nothing twice." })),
            }),
            execute: async (_toolCallId, params) =>
              toolResult(await once(threadId, "send", decodeClientRequestId(params), () => sendTo(threadId, params))),
          },
          {
            name: "tau_cancel_thread",
            label: "Cancel thread",
            description: [
              "Stop a thread spawned from here: a queued one never starts, a running one ends its turn.",
              "Its transcript and worktree stay, and a message sent with tau_send_to_thread starts it again. Cancelling a finished thread changes nothing.",
            ].join(" "),
            parameters: Type.Object({
              threadId: Type.String({ description: "Thread id returned by tau_spawn_thread." }),
              clientRequestId: Type.Optional(Type.String({ description: "Your own id for this request; a retry with the same id returns the first result." })),
            }),
            execute: async (_toolCallId, params) =>
              toolResult(await once(threadId, "cancel", decodeClientRequestId(params), () => cancelChild(threadId, params))),
          },
          {
            name: "tau_apply_thread_changes",
            label: "Apply thread changes",
            description: [
              "Take the work of a thread spawned from here into this checkout, and remove its worktree.",
              "A thread that committed everything is merged; anything else is applied as one patch of its whole working copy.",
              "Nothing is applied when it would collide: the error names the branch, which stays for you to merge by hand.",
            ].join(" "),
            parameters: Type.Object({
              threadId: Type.String({ description: "Thread id returned by tau_spawn_thread." }),
              discard: Type.Optional(Type.Boolean({ description: "Throw the work away instead of applying it; the worktree and its branch go too." })),
            }),
            execute: async (_toolCallId, params) => {
              const link = requireChild(threadId, decodeThreadId(params));
              const discard = (params as { discard?: unknown }).discard === true;
              return toolResult(await settleWorkspace(link.id, discard ? "discarded" : "applied"));
            },
          },
          {
            name: "tau_list_threads",
            label: "List spawned threads",
            description: "List the threads spawned from this one, with what each is doing.",
            parameters: Type.Object({}),
            execute: async () => toolResult({
              threads: book.childrenOf(threadId).map((link) => ({
                threadId: link.threadId ?? link.id,
                title: link.title,
                status: link.status,
                spawnedAt: link.spawnedAt,
                ...(link.machine ? { machine: link.machine.name } : {}),
              })),
            }),
          },
        ];
      };

      const runtimeExtension = (pi: ExtensionAPI, session: RuntimeSessionInfo) => {
        const threadId = session.sessionId;
        // A dialog a spawned thread opens is answered by the user in that
        // thread; the parent only learns that it is waiting on one.
        pi.on("ui_prompt_start", (event) => { changed(threadId, book.notePrompt(threadId, event.title ?? event.kind)); });
        pi.on("ui_prompt_end", () => { changed(threadId, book.notePrompt(threadId, undefined)); });

        // A thread started from a definition carries it in its own link entry;
        // `null` until that entry was read for this runtime.
        let persona: AgentPersona | undefined | null = null;
        let access: "applied" | "narrowed" | undefined;
        const personaFor = (ctx: ExtensionContext) => {
          if (persona === null) persona = personaFromEntries(ctx.sessionManager.getEntries());
          return persona;
        };
        const applyPersona = async (ctx: ExtensionContext) => {
          const current = personaFor(ctx);
          if (!current) return;
          if (current.access && current.access !== "full" && access === undefined) {
            try {
              await context.invokeHostExtension(ACCESS_KIT_ID, ACCESS_THREAD_LEVEL_COMMAND, { threadId, level: current.access });
              access = "applied";
            } catch (error) {
              // Without Access Kit nothing gates this thread, so it loses the tools that write.
              access = "narrowed";
              services.log("agents.access-narrowed", `${threadId.slice(0, 8)} · ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          const tools = personaTools(current, pi.getAllTools().map((tool) => tool.name), pi.getActiveTools(), access === "narrowed");
          if (!sameTools(tools, pi.getActiveTools())) pi.setActiveTools(tools);
        };
        pi.on("session_start", async (_event, ctx) => {
          persona = null;
          access = undefined;
          await applyPersona(ctx);
        });
        pi.on("before_agent_start", async (event, ctx) => {
          // Tools set here count for this turn; the prompt's own tool list catches up next turn.
          await applyPersona(ctx);
          const sections: string[] = [];
          const current = personaFor(ctx);
          if (current) sections.push(personaSection(current));
          if (pi.getActiveTools().includes("tau_spawn_thread") && book.depthOf(threadId) < MAX_AGENT_DEPTH) {
            const listing = definitionsSection((await definitionReader.read(session.cwd)).definitions);
            if (listing) sections.push(listing);
          }
          return sections.length > 0 ? { systemPrompt: [event.systemPrompt, ...sections].join("\n\n") } : undefined;
        });

        for (const tool of agentTools(session)) pi.registerTool(tool);
      };

      /** A child's turn ended, here or on its machine: note it, wake its parent if nobody waited, free its slot. */
      const childEnded = async (idOrThreadId: string, outcome: "completed" | "failed"): Promise<void> => {
        const link = book.linkFor(idOrThreadId);
        if (!link) return;
        // Read before the end is noted: noting it releases whoever waits.
        const watched = (waiters.get(link.id)?.size ?? 0) > 0;
        changed(link.id, book.noteEnded(link.id, outcome, Date.now()));
        // The index now carries when the agent ran, so a restart can still
        // show its duration; that is only known once the turn is over.
        save();
        if (!link.machine) {
          const answer = await lastAssistantMessage(link.threadId);
          if (answer) changed(link.id, book.noteResult(link.id, truncate(answer, PANEL_RESULT_LIMIT)));
          // The panel's done row says what its worktree changed ("+48 −0 · 1 file").
          const workspace = await readChanges(link);
          if (workspace && JSON.stringify(workspace) !== JSON.stringify(link.workspace)) changed(link.id, book.noteWorkspace(link.id, workspace));
        }
        // The last turn a tool gave it, or one that failed, and nobody waited: its parent hears.
        const left = (expecting.get(link.id) ?? 0) - 1;
        if (left > 0 && outcome !== "failed") expecting.set(link.id, left);
        else if (expecting.delete(link.id) && !watched) {
          const pending = unreported.get(link.parentThreadId) ?? new Set<string>();
          pending.add(link.id);
          unreported.set(link.parentThreadId, pending);
          void flushWakes(link.parentThreadId);
        }
        // A finished agent frees one of its parent's slots, and one on its machine.
        if (link.machine) for (const parentThreadId of book.parentsWithQueued()) void pump(parentThreadId);
        else void pump(link.parentThreadId);
      };

      let priority: AgentPriority = DEFAULT_AGENT_PRIORITY;
      const disposers = [
        services.registerRuntimeExtension("tau-agents", runtimeExtension, {
          // A spawned thread's commands yield to the user's own work.
          shellCommandPrefix: (session) => session.parentThreadId ? priorityPrefix(priority) : undefined,
        }),
        services.mcp.registerTools(agentTools),
        services.registerTurnObserver({
          accepted: (sessionId) => { changed(sessionId, book.noteAccepted(sessionId)); },
          toolEnded: (sessionId, tool) => { changed(sessionId, book.noteTool(sessionId, toolLine(tool))); },
          ended: async (sessionId, _turnId, outcome) => {
            // A parent whose turn ended hears what finished meanwhile.
            if (unreported.has(sessionId)) void flushWakes(sessionId, true);
            if (book.has(sessionId)) await childEnded(sessionId, outcome);
          },
          closed: async (sessionId) => { changed(sessionId, book.noteClosed(sessionId)); },
          reset: async (sessionId) => { changed(sessionId, book.noteClosed(sessionId)); },
          // An agent someone is waiting on is not an idle runtime to release.
          pending: (sessionId) => waiters.get(book.linkFor(sessionId)?.id ?? "")?.size ?? 0,
        }),
        services.registerThreadLifecycle({
          /**
           * A deleted thread takes its link with it, and its worktree when
           * nothing would be lost with it. A worktree that still holds work
           * stays: the parent can still merge that branch by hand, and what
           * else to do with it is a policy question, not this hook's.
           */
          threadDeleted: async (sessionId) => {
            const link = book.linkFor(sessionId);
            const workspace = link?.workspace;
            if (link && workspace?.mode === "worktree" && workspace.branch && !workspace.settled) {
              const worktree = { path: workspace.path, branch: workspace.branch };
              const changes = await readAgentWorktreeChanges(worktree, runGit).catch(() => undefined);
              if (changes && changes.files === 0 && changes.commits === 0) {
                await removeAgentWorktree({ parentCwd: link.projectPath, worktree, runGit }).catch(() => undefined);
                services.log("agents.worktree-removed", `${workspace.branch} went with its deleted thread`);
              } else {
                services.log("agents.worktree-kept", `${workspace.branch} still holds work; it outlives its deleted thread`);
              }
            }
            unreported.delete(sessionId);
            if (link) { expecting.delete(link.id); reported(link.parentThreadId, link.id); }
            if (book.forget(sessionId)) { publish(); save(); }
          },
          beforeOpen: async (session) => {
            const links = linksFromEntries(session.sessionId, session.entries());
            for (const link of links) if (!book.has(link.id)) book.add(link);
            if (links.length > 0) publish();
          },
          sweep: async ({ sessions, liveThreads, deleted }) => {
            let changedState = false;
            for (const session of deleted) changedState = book.forget(session.sessionId) || changedState;
            // The index carries the link now, so an agent survives a lost
            // links file: whatever it named is an agent, whether or not this
            // run ever saw it spawned.
            for (const session of sessions) {
              if (!session.parentThreadId || book.has(session.sessionId)) continue;
              book.add({
                id: session.sessionId,
                threadId: session.sessionId,
                parentThreadId: session.parentThreadId,
                spawnedBy: "tau_spawn_thread",
                spawnedAt: 0,
                projectPath: session.cwd,
                depth: 1,
                title: "Sub-agent",
              });
              changedState = true;
            }
            // The scan is the whole index, so anything it does not name is gone.
            const known = new Set([...sessions.map((entry) => entry.sessionId), ...liveThreads.map((thread) => thread.sessionId)]);
            changedState = book.prune(known) || changedState;
            if (changedState) { publish(); save(); }
          },
        }),
        context.registerCommand("state", () => book.state(), { access: "read" }),
        // The panel's two row actions; the tools do the same from a turn.
        context.registerCommand("apply-changes", (input) => settleWorkspace(requireThreadId(input), "applied"), { long: true }),
        context.registerCommand("discard-changes", (input) => settleWorkspace(requireThreadId(input), "discarded"), { long: true }),
        context.registerCommand("definitions", async (input): Promise<AgentDefinitionsState> => {
          const sessionId = record(input).sessionId;
          const thread = typeof sessionId === "string" && sessionId ? services.thread(sessionId) : undefined;
          const report = await definitionReader.read(thread?.cwd ?? services.cwd());
          return { directory: report.directory, definitions: report.definitions.map(summarize), problems: report.problems };
        }, { access: "read" }),
        // Settings → Agents: where sub-agents may run, and how many at once on each.
        context.registerCommand("machines", (): AgentMachinesView => {
          const machines = services.machines;
          if (!machines) return { available: false, machines: [] };
          return {
            available: true,
            machines: machines.list().map((machine) => {
              const budget = remote.knownBudget(machine.id);
              return {
                id: machine.id, name: machine.name, status: machine.status,
                ...(machine.readOnly ? { readOnly: true } : {}),
                ...(budget ? { budget } : {}),
              };
            }),
          };
        }, { access: "read" }),
        // The panel's "Start": the user spawns from a definition into the thread they read.
        context.registerCommand("start", async (input) => {
          const parentThreadId = requireText(input, "parentThreadId");
          const agent = requireText(input, "agent");
          const prompt = requireText(input, "prompt");
          const parent = services.thread(parentThreadId);
          if (!parent) throw new HostCommandError("Open the thread this agent should belong to, then start it again.");
          return spawn({ sessionId: parent.sessionId, cwd: parent.cwd }, { prompt, agent }, undefined, "agents-panel");
        }, { long: true }),
      ];

      // Both reads finish before the extension is active, so the first thing
      // the desktop half asks for already holds every link from the last run.
      const settings = await readAgentsSettings(options.settingsPath);
      book.setMaxRunning(settings.maxRunning);
      priority = settings.priority;
      const restoring: string[] = [];
      for (const { remote: there, ...link } of await readAgentLinksWithMigration(linksPath)) {
        if (there) {
          if (book.has(there.id)) continue;
          book.add({ ...link, id: there.id, machine: { ...there.machine } });
          restoring.push(there.id);
        } else if (link.threadId && !book.has(link.threadId)) book.add({ ...link, id: link.threadId, threadId: link.threadId });
      }
      publish();
      // Remote Work may activate after this kit: a child there is read back once it answers.
      for (const id of restoring) void remote.restore(id);

      return () => {
        remote.close();
        if (publishing) clearTimeout(publishing);
        if (saving) clearTimeout(saving);
        for (const dispose of [...disposers].reverse()) dispose();
      };
    },
  };
}

export default createAgentsHostExtension;
