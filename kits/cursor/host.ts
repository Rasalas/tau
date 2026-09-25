import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_INSTANCE_ID,
  HostCommandError,
  RuntimeInstanceSettings,
  THREAD_TEXTS_COMMAND,
  TurnActivityStore,
  runtimeUpdateCommand,
  runtimeVersionPolicy,
  threadTextsDelta,
  updateAvailable,
  type HostBackendThreadRecord,
  type HostExtension,
  type HostExtensionServices,
  type HostRuntimeBackendProvider,
  type HostRuntimeNewThreadCatalog,
  type RuntimeInstanceConfig,
  type RuntimeToolVersion,
} from "tau/host-extension";
import type { AcpProcess, AcpSpawnInput } from "../_acp/client.js";
import { withTauServer } from "../_acp/mcp.js";
import { cursorNewThreadCatalog, storedModels } from "./catalog.js";
import { CURSOR_VERSION_POLICY, cursorCompatibility, cursorEnvironment, cursorLatestVersion, cursorUpdateCommand, readCursorAbout, readCursorVersion, type CursorAbout } from "./cli.js";
import {
  CURSOR_BACKEND_KIND,
  CURSOR_HOME_VARIABLE,
  CURSOR_HOST_EXTENSION_ID,
  INSTANCES_EVENT,
  SEARCH_KIT_ID,
  USAGE_KIT_ID,
  type CursorInstancesReport,
  type CursorStatusReport,
} from "./protocol.js";
import { createCursorRuntimeAdapter } from "./runtime-adapter.js";
import { listCursorModels, openCursorSession } from "./session.js";
import { CursorSessionStore, type CursorStoredModel } from "./session-store.js";
import { CursorThreadRuntimeBackend, type CursorSessionInput, type CursorSessionLike } from "./thread-backend.js";

export { CURSOR_BACKEND_KIND, CURSOR_HOST_EXTENSION_ID };

export const CURSOR_COMMAND_VARIABLE = "TAU_CURSOR_COMMAND";
/** The name the CLI installs itself under; it also installs `agent`, which is too generic to look for. */
const EXECUTABLE = "cursor-agent";
const PROBE_TTL_MS = 10 * 60 * 1000;

export interface CursorHostExtensionOptions {
  /** Replaces the agent process (tests hand in a fake); the real one spawns `cursor-agent acp`. */
  spawn?(input: AcpSpawnInput): AcpProcess;
  sessionsDir?: string;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
  readVersion?(path: string, env: NodeJS.ProcessEnv): Promise<string | undefined>;
  readAbout?(path: string, env: NodeJS.ProcessEnv): Promise<CursorAbout>;
  fetch?: typeof globalThis.fetch;
}

interface Probe { models: CursorStoredModel[]; at: number }
interface InstanceState {
  installed?: { path: string; version?: string };
  probe?: Promise<Probe>;
  unregister?: () => void;
}

function instanceInput(input: unknown): string {
  const id = (input as { instance?: unknown } | undefined)?.instance;
  return typeof id === "string" && id ? id : DEFAULT_INSTANCE_ID;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Cursor as a runtime backend (ADR 0005): a thread drives the Cursor CLI's
 * ACP server (`cursor-agent acp`), signed in with the CLI's own login. The
 * protocol is `kits/_acp`, shared with Antigravity. Each instance — the
 * default one and any the user adds on the Providers page — registers a
 * backend of its own (`cursor`, `cursor@<id>`), so a thread keeps its instance.
 */
export function createCursorHostExtension(options: CursorHostExtensionOptions = {}): HostExtension {
  return {
    id: CURSOR_HOST_EXTENSION_ID,
    name: "Cursor",
    permissions: ["process", "sessions", "runtime:extend", "network"],
    activate(context) {
      const services: HostExtensionServices = context.services;
      const env = options.env ?? process.env;
      const storePath = CursorSessionStore.defaultPath(options.sessionsDir ?? services.sessionsDir);
      const store = new CursorSessionStore({ filePath: storePath });
      const activity = new TurnActivityStore({ directory: join(dirname(storePath), "cursor-activity") });
      const readVersion = options.readVersion ?? readCursorVersion;
      const readAbout = options.readAbout ?? readCursorAbout;
      const settings = new RuntimeInstanceSettings({
        file: join(services.stateDir, "settings.json"),
        driver: CURSOR_BACKEND_KIND,
        label: "Cursor",
        executable: EXECUTABLE,
        commandVariable: CURSOR_COMMAND_VARIABLE,
        homeVariable: CURSOR_HOME_VARIABLE,
        env,
      });
      const policy = runtimeVersionPolicy(CURSOR_BACKEND_KIND, CURSOR_VERSION_POLICY, env);
      const states = new Map<string, InstanceState>();
      const state = (id: string): InstanceState => {
        let entry = states.get(id);
        if (!entry) states.set(id, entry = {});
        return entry;
      };
      const requireInstance = (id: string): RuntimeInstanceConfig => {
        const instance = settings.get(id);
        if (!instance) throw new HostCommandError(`Cursor has no instance “${id}”.`);
        return instance;
      };

      const cursorCommand = (id: string): string => settings.command(id).command;
      const instanceEnv = (id: string): NodeJS.ProcessEnv => cursorEnvironment(settings.environment(id, env));
      const locate = (id: string): string | undefined => services.findCommand(cursorCommand(id));
      const cli = async (id: string): Promise<{ path: string; version?: string }> => {
        const path = locate(id);
        if (!path) throw new Error(`The Cursor CLI "${cursorCommand(id)}" was not found on the PATH of your login shell. Install it (curl https://cursor.com/install -fsS | bash) or set its path under Settings → Providers.`);
        const entry = state(id);
        if (entry.installed?.path !== path) entry.installed = { path, ...(await readVersion(path, instanceEnv(id)).then((version) => version ? { version } : {})) };
        return entry.installed;
      };
      const updateCommand = (path: string) => runtimeUpdateCommand(CURSOR_BACKEND_KIND, cursorUpdateCommand(path), env);
      /** An old CLI has no `acp` and would take the word for a prompt, so it is never started with one. */
      const refuseBroken = ({ path, version }: { path: string; version?: string }): void => {
        const verdict = cursorCompatibility(policy, version);
        if (verdict?.status !== "broken") return;
        throw new Error(`Cursor CLI ${version ?? "(unknown version)"} does not work with Tau: ${verdict.message ?? ""} Update it with: ${updateCommand(path)}`.replace(/\s+/gu, " ").trim());
      };

      /** The CLI's ACP server for a thread (with Tau's tools) or a probe (without). */
      const open = async (id: string, input: CursorSessionInput | (Omit<CursorSessionInput, "threadId"> & { threadId?: undefined })) => {
        const found = await cli(id);
        refuseBroken(found);
        const tau = input.threadId ? await services.mcp.connect({ sessionId: input.threadId, cwd: input.cwd }).catch(() => undefined) : undefined;
        if (!options.spawn) services.noteSubprocess();
        const session = await openCursorSession({
          command: found.path,
          args: settings.args(id),
          cwd: input.cwd,
          env: instanceEnv(id),
          clientVersion: options.clientVersion ?? "0.0.0",
          ...(options.spawn ? { spawn: options.spawn } : {}),
          mcpServers: withTauServer([], tau),
          onUpdate: input.onUpdate,
          onPermission: input.onPermission,
          onElicitation: input.onElicitation,
          onNotification: input.onNotification,
          onExit: input.onExit,
          onStderrLine: (line) => services.log("cursor.stderr", line.slice(0, 500)),
        });
        services.log("cursor.session", `${input.threadId ? `thread ${input.threadId}` : "probe"} on instance ${id}${tau ? " with Tau's tools" : ""}`);
        return session;
      };

      /** The account's models, from a session that runs no thread. */
      const runProbe = (id: string, fresh = false): Promise<Probe> => {
        const entry = state(id);
        if (!fresh && entry.probe) return entry.probe.then((cached) => Date.now() - cached.at < PROBE_TTL_MS ? cached : runProbe(id, true));
        const next = (async (): Promise<Probe> => {
          await mkdir(services.stateDir, { recursive: true });
          const session = await open(id, {
            cwd: services.stateDir,
            onUpdate: () => undefined,
            onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
            onElicitation: async () => ({ action: "decline" }),
            onNotification: () => undefined,
            onExit: () => undefined,
          });
          try {
            return { models: storedModels(await listCursorModels(session)), at: Date.now() };
          } finally {
            await session.close().catch(() => undefined);
          }
        })();
        entry.probe = next;
        next.catch(() => { if (entry.probe === next) entry.probe = undefined; });
        return next;
      };

      const record = (entry: Awaited<ReturnType<CursorSessionStore["list"]>>[number]): HostBackendThreadRecord => ({
        threadId: entry.tauThreadId,
        cwd: entry.cwd,
        ...(entry.title ? { title: entry.title } : {}),
        updatedAt: entry.updatedAt,
        messages: entry.messages,
      });

      const versionOf = async (id: string): Promise<RuntimeToolVersion | undefined> => {
        const { path, version } = await cli(id);
        // Test instances set TAU_NO_RUNTIME_UPDATES=1: no update is asked for or offered.
        const latest = env.TAU_NO_RUNTIME_UPDATES === "1"
          ? undefined
          : await cursorLatestVersion({ cacheFile: join(services.stateDir, "latest-version.json"), ...(options.fetch ? { fetch: options.fetch } : {}) });
        const verdict = cursorCompatibility(policy, version);
        return {
          tool: "cursor-agent",
          ...(version ? { installed: version } : {}),
          ...(latest ? { latest } : {}),
          updateCommand: updateCommand(path),
          ...(verdict ? { compatibility: verdict } : {}),
        };
      };

      const newThreadCatalog = async (id: string): Promise<HostRuntimeNewThreadCatalog> => {
        if (!locate(id)) return { models: [], thinkingLevels: {}, status: "not-installed", note: `The Cursor CLI "${cursorCommand(id)}" is not installed.` };
        const found = await cli(id);
        try {
          refuseBroken(found);
        } catch (error) {
          return { models: [], thinkingLevels: {}, status: "unavailable", note: errorText(error) };
        }
        if ((await readAbout(found.path, instanceEnv(id))).signedIn === false) {
          return { models: [], thinkingLevels: {}, status: "sign-in-required", note: "Cursor is not signed in. Run cursor-agent login in a terminal, then open the picker again." };
        }
        const probe = await runProbe(id);
        await store.setModels(probe.models, id).catch(() => undefined);
        return cursorNewThreadCatalog(probe.models);
      };

      const providerFor = (id: string): HostRuntimeBackendProvider => {
        const kind = settings.kind(id);
        const adapter = createCursorRuntimeAdapter(kind);
        return {
          kind,
          label: settings.label(id),
          order: 50,
          adapter,
          listThreads: async () => (await store.list(id)).map(record),
          removeThread: async (threadId) => {
            const taken = await store.take(threadId);
            const tools = await activity.take(threadId);
            return taken && tools ? { ...taken, activity: tools } : taken;
          },
          restoreThread: async (threadId, value) => {
            await store.put(threadId, value);
            await activity.put(threadId, (value as { activity?: unknown } | undefined)?.activity);
          },
          lookup: async (threadId) => {
            const entry = await store.get(threadId);
            return entry && (entry.instance ?? DEFAULT_INSTANCE_ID) === id ? record(entry) : undefined;
          },
          open: async (threadId, cwd, { resume }, thread) => {
            const backend = new CursorThreadRuntimeBackend(threadId, cwd, {
              adapter,
              store,
              activity,
              instance: id,
              openSession: (input) => open(id, input) as Promise<CursorSessionLike>,
              storedModels: () => store.listModels(id),
              permissionLevel: thread.permissionLevel,
              onMessage: thread.onMessage,
              onEvent: thread.onEvent,
              ask: thread.ask,
            });
            await backend.start(resume ? "resume" : "create");
            return backend;
          },
          composerCommands: () => [],
          version: () => versionOf(id),
          newThreadCatalog: () => newThreadCatalog(id),
        };
      };

      const register = (id: string): void => {
        const entry = state(id);
        entry.unregister?.();
        entry.installed = undefined;
        entry.probe = undefined;
        entry.unregister = services.registerRuntimeBackend(providerFor(id));
      };
      const unregister = (id: string): void => {
        states.get(id)?.unregister?.();
        states.delete(id);
      };

      const instancesReport = async (): Promise<CursorInstancesReport> => {
        const threads = await store.list();
        return {
          instances: settings.list().map((instance) => ({
            ...instance,
            kind: settings.kind(instance.id),
            label: settings.label(instance.id),
            threads: threads.filter((entry) => (entry.instance ?? DEFAULT_INSTANCE_ID) === instance.id).length,
          })),
        };
      };
      const announce = async (): Promise<CursorInstancesReport> => {
        const report = await instancesReport();
        context.emit(INSTANCES_EVENT, report);
        return report;
      };

      context.registerCommand("status", async (input): Promise<CursorStatusReport> => {
        const id = instanceInput(input);
        requireInstance(id);
        const { command, source } = settings.command(id);
        const fresh = Boolean(input && typeof input === "object" && (input as { fresh?: unknown }).fresh);
        const base: CursorStatusReport = { instance: id, command, ...(source ? { commandSource: source } : {}) };
        let found: { path: string; version?: string };
        try {
          if (fresh) state(id).installed = undefined;
          found = await cli(id);
        } catch (error) {
          return { ...base, message: errorText(error) };
        }
        const version = await versionOf(id).catch(() => undefined);
        const report: CursorStatusReport = {
          ...base,
          path: found.path,
          ...(found.version ? { version: found.version } : {}),
          ...(version?.latest ? { latest: version.latest } : {}),
          ...(version?.updateCommand ? { updateCommand: version.updateCommand } : {}),
          ...(updateAvailable(version) ? { updateAvailable: true } : {}),
          ...(version?.compatibility ? { compatibility: version.compatibility } : {}),
          ...(version?.compatibility?.status === "broken" ? { unsupported: true } : {}),
        };
        if (report.unsupported) return report;
        const about = await readAbout(found.path, instanceEnv(id));
        const signed: CursorStatusReport = { ...report, ...(about.signedIn !== undefined ? { signedIn: about.signedIn } : {}), ...(about.account ? { account: about.account } : {}), ...(about.plan ? { plan: about.plan } : {}) };
        if (about.signedIn === false) return signed;
        try {
          const probe = await Promise.race([
            runProbe(id, fresh),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Cursor did not answer within 30 s.")), 30_000).unref?.()),
          ]);
          await store.setModels(probe.models, id).catch(() => undefined);
          return { ...signed, signedIn: true, models: probe.models.length };
        } catch (error) {
          return { ...signed, message: errorText(error) };
        }
      }, { access: "read" });
      context.registerCommand("instances", () => instancesReport(), { access: "read" });
      context.registerCommand("save-instance", async (input) => {
        const requested = (input as { instance?: unknown } | undefined)?.instance as RuntimeInstanceConfig | undefined;
        if (!requested || typeof requested.id !== "string") throw new HostCommandError("Name the instance to save.");
        if (requested.id === DEFAULT_INSTANCE_ID && requested.command !== settings.get(DEFAULT_INSTANCE_ID)?.command && settings.command(DEFAULT_INSTANCE_ID).source === "env") {
          throw new HostCommandError(`${CURSOR_COMMAND_VARIABLE} is set in Tau's environment and decides the path.`);
        }
        if (requested.command && !services.findCommand(requested.command)) throw new HostCommandError(`No executable at "${requested.command}".`);
        try {
          await settings.save(requested);
        } catch (error) {
          throw new HostCommandError(errorText(error));
        }
        register(requested.id);
        return announce();
      });
      context.registerCommand("remove-instance", async (input) => {
        const id = instanceInput(input);
        if (id === DEFAULT_INSTANCE_ID) throw new HostCommandError("The default instance cannot be removed.");
        await settings.remove(id);
        unregister(id);
        return announce();
      });
      context.registerCommand("set-command", async (input) => {
        const id = instanceInput(input);
        const current = requireInstance(id);
        const requested = typeof (input as { command?: unknown } | undefined)?.command === "string" ? (input as { command: string }).command.trim() : "";
        if (settings.command(id).source === "env") throw new HostCommandError(`${CURSOR_COMMAND_VARIABLE} is set in Tau's environment and decides the path.`);
        if (requested && !services.findCommand(requested)) throw new HostCommandError(`No executable at "${requested}".`);
        const { command: _command, ...rest } = current;
        await settings.save({ ...rest, ...(requested ? { command: requested } : {}) });
        register(id);
        return { command: cursorCommand(id) };
      });
      context.registerCommand("recheck", async (input) => {
        const id = instanceInput(input);
        requireInstance(id);
        register(id);
        return versionOf(id).catch(() => undefined);
      });
      // Each thread's running total, for the Usage kit; read from the store, never from Cursor.
      context.registerCommand("usage", async () => ({
        threads: (await store.list()).map((entry) => {
          const model = entry.model ?? entry.observedModel;
          return { threadId: entry.tauThreadId, cwd: entry.cwd, updatedAt: entry.updatedAt, ...(model ? { model } : {}), ...(entry.usage ? { usage: { ...entry.usage } } : {}) };
        }),
      }), { access: "read", callers: [USAGE_KIT_ID] });
      context.registerCommand(THREAD_TEXTS_COMMAND, async (input) => threadTextsDelta(await store.list(), input), { long: true, callers: [SEARCH_KIT_ID] });

      for (const instance of settings.list()) register(instance.id);
      return () => { for (const id of [...states.keys()]) unregister(id); };
    },
  };
}

export default createCursorHostExtension;
