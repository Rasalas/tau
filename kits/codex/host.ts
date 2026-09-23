import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  HostCommandError,
  commandInvocation,
  compareVersions,
  npmLatestVersion,
  packageUpdateCommand,
  updateAvailable,
  type HostBackendThreadRecord,
  type HostExtension,
  type HostExtensionServices,
  type HostRuntimeBackendProvider,
  type RuntimeToolVersion,
} from "tau/host-extension";
import { CodexAppServer, type CodexAccount, type CodexModel } from "./app-server.js";
import { codexSessionDirs, importCodexSessions, scanCodexSessions } from "./history-import.js";
import { codexMcpLaunch } from "./mcp.js";
import { codexToolArgs } from "./tools.js";
import { CODEX_BACKEND_KIND, CODEX_HOST_EXTENSION_ID, CODEX_NPM_PACKAGE, MIN_CODEX_VERSION, ONBOARDING_KIT_ID, USAGE_KIT_ID, type CodexStatusReport } from "./protocol.js";
import { createCodexRuntimeAdapter } from "./runtime-adapter.js";
import { CommandOverride } from "./command-override.js";
import { CodexSessionStore, type CodexStoredModel } from "./session-store.js";
import { CodexThreadRuntimeBackend, storedModel, type CodexSessionInput, type CodexSessionLike } from "./thread-backend.js";

export { CODEX_BACKEND_KIND, CODEX_HOST_EXTENSION_ID };

export interface CodexHostExtensionOptions {
  /** Opens a session (tests script one); the real one spawns `codex app-server`. */
  openSession?(input: CodexSessionInput & { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }): Promise<CodexSessionLike>;
  sessionsDir?: string;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
  /** `codex --version`; tests answer it. */
  readVersion?(path: string): Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
}

/** What `status` and the model list need of the CLI, asked without a thread. */
interface Probe { account?: CodexAccount; models: CodexModel[]; codexHome?: string; at: number }
const PROBE_TTL_MS = 10 * 60 * 1000;

export const CODEX_COMMAND_VARIABLE = "TAU_CODEX_COMMAND";

export async function readCodexVersion(path: string): Promise<string | undefined> {
  try {
    const invocation = commandInvocation(path, ["--version"]);
    const { stdout } = await promisify(execFile)(invocation.command, invocation.args, { timeout: 10_000, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments });
    return /\d+\.\d+\.\d+[^\s]*/u.exec(String(stdout))?.[0];
  } catch {
    return undefined;
  }
}

function accountSummary(account: CodexAccount | undefined): CodexStatusReport["account"] {
  if (!account) return undefined;
  if (account.type === "chatgpt") {
    const chatgpt = account as { planType?: string; email?: string | null };
    return { kind: "chatgpt", ...(chatgpt.planType ? { plan: chatgpt.planType } : {}), ...(chatgpt.email ? { email: chatgpt.email } : {}) };
  }
  return { kind: account.type === "apiKey" ? "apiKey" : "other" };
}

/**
 * OpenAI's Codex CLI as a runtime backend (ADR 0005): threads of this kind
 * drive the installed `codex` through `codex app-server` and persist in Tau's
 * app data. The login is the CLI's own; `CODEX_HOME` passes through, so the
 * sessions land wherever the user's Codex keeps them.
 */
export function createCodexHostExtension(options: CodexHostExtensionOptions = {}): HostExtension {
  return {
    id: CODEX_HOST_EXTENSION_ID,
    name: "Codex",
    permissions: ["process", "sessions", "runtime:extend", "network"],
    activate(context) {
      const services: HostExtensionServices = context.services;
      const env = options.env ?? process.env;
      const adapter = createCodexRuntimeAdapter();
      const store = new CodexSessionStore({ filePath: CodexSessionStore.defaultPath(options.sessionsDir ?? services.sessionsDir) });
      const readVersion = options.readVersion ?? readCodexVersion;
      let installed: { path: string; version?: string } | undefined;
      let probe: Promise<Probe> | undefined;
      const override = new CommandOverride(join(services.stateDir, "settings.json"), CODEX_COMMAND_VARIABLE, env);
      const codexCommand = (): string => override.current()?.command ?? "codex";

      const locate = (): string | undefined => services.findCommand(codexCommand());
      const updateCommand = async (path: string | undefined): Promise<string> => {
        const real = path ? await realpath(path).catch(() => path) : undefined;
        return (real && packageUpdateCommand(real, CODEX_NPM_PACKAGE)) ?? "codex update";
      };
      /** The CLI on the PATH and its version; read once per path. */
      const cli = async (): Promise<{ path: string; version?: string }> => {
        const path = locate();
        if (!path) throw new Error(`The Codex CLI "${codexCommand()}" was not found on the PATH of your login shell. Install it (brew install --cask codex, or npm install -g ${CODEX_NPM_PACKAGE}) or set its path under Settings → Providers.`);
        if (installed?.path !== path) installed = { path, ...(await readVersion(path).then((version) => version ? { version } : {})) };
        return installed;
      };
      const assertSupported = async (): Promise<string> => {
        const { path, version } = await cli();
        if (version && compareVersions(version, MIN_CODEX_VERSION) < 0) {
          throw new Error(`Codex ${version} is older than ${MIN_CODEX_VERSION}, the oldest release Tau speaks to. Update it with: ${await updateCommand(path)}`);
        }
        return path;
      };

      const spawnSession = async (input: CodexSessionInput): Promise<CodexSessionLike> => {
        const command = await assertSupported();
        // A thread's session reaches Tau's tools; without the endpoint it still runs, only without them.
        const mcp = input.threadId
          ? await services.mcp.connect({ sessionId: input.threadId, cwd: input.cwd }, input.tools ? { tools: input.tools } : undefined).catch(() => undefined)
          : undefined;
        const tau = mcp ? codexMcpLaunch(mcp) : { args: [], env: {} };
        const launch = { args: [...tau.args, ...(input.tools ? codexToolArgs(input.tools) : [])], env: tau.env };
        const sessionEnv = { ...env, ...launch.env };
        if (options.openSession) return options.openSession({ ...input, command, args: launch.args, env: sessionEnv });
        services.noteSubprocess();
        const server = await CodexAppServer.open({
          command,
          args: launch.args,
          cwd: input.cwd,
          env: sessionEnv,
          clientVersion: options.clientVersion ?? "0.0.0",
          onNotification: input.onNotification,
          onRequest: input.onRequest,
          onExit: input.onExit,
          onStderrLine: (line) => services.log("codex.stderr", line.slice(0, 500)),
        });
        services.log("codex.session", `app-server for ${input.cwd}, home ${server.codexHome ?? "unknown"}`);
        return server;
      };

      /** Account and models, from a short-lived app-server that starts no thread. */
      const runProbe = (fresh = false): Promise<Probe> => {
        if (!fresh && probe) return probe.then((cached) => Date.now() - cached.at < PROBE_TTL_MS ? cached : runProbe(true));
        const next = (async (): Promise<Probe> => {
          await mkdir(services.stateDir, { recursive: true });
          const session = await spawnSession({
            cwd: services.stateDir,
            onNotification: () => undefined,
            onRequest: async () => { throw new Error("No thread runs in a probe."); },
            onExit: () => undefined,
          });
          try {
            const [account, models] = await Promise.all([session.account?.(), session.models()]);
            return { ...(account ? { account } : {}), models, ...(session.codexHome ? { codexHome: session.codexHome } : {}), at: Date.now() };
          } finally {
            await session.close().catch(() => undefined);
          }
        })();
        probe = next;
        next.catch(() => { if (probe === next) probe = undefined; });
        return next;
      };

      const cachedModels = async (): Promise<CodexStoredModel[]> => {
        const stored = await store.listModels();
        if (stored.length > 0) return stored;
        const models = (await runProbe()).models.map(storedModel);
        await store.setModels(models);
        return models;
      };

      const record = (entry: Awaited<ReturnType<CodexSessionStore["list"]>>[number]): HostBackendThreadRecord => ({
        threadId: entry.tauThreadId,
        cwd: entry.cwd,
        ...(entry.title ? { title: entry.title } : {}),
        updatedAt: entry.updatedAt,
        messages: entry.messages,
      });

      const provider: HostRuntimeBackendProvider = {
        kind: CODEX_BACKEND_KIND,
        label: "Codex",
        adapter,
        modelProvider: "openai",
        listThreads: async () => (await store.list()).map(record),
        removeThread: (threadId) => store.take(threadId),
        restoreThread: (threadId, value) => store.put(threadId, value),
        lookup: async (threadId) => {
          const entry = await store.get(threadId);
          return entry ? record(entry) : undefined;
        },
        restrictsTools: true,
        open: async (threadId, cwd, { resume, tools }, thread) => {
          await assertSupported();
          const backend = new CodexThreadRuntimeBackend(threadId, cwd, {
            adapter,
            store,
            openSession: spawnSession,
            storedModels: () => store.listModels(),
            models: cachedModels,
            onModels: (models) => void store.setModels(models).catch(() => undefined),
            permissionLevel: thread.permissionLevel,
            ...(tools ? { tools } : {}),
            onMessage: thread.onMessage,
            onEvent: thread.onEvent,
            ask: thread.ask,
          });
          await backend.start(resume ? "resume" : "create");
          return backend;
        },
        composerCommands: () => [],
        version: async (): Promise<RuntimeToolVersion | undefined> => {
          const { path, version } = await cli();
          const latest = await npmLatestVersion(CODEX_NPM_PACKAGE, { cacheFile: join(services.stateDir, "latest-version.json"), ...(options.fetch ? { fetch: options.fetch } : {}) });
          return { tool: "codex", ...(version ? { installed: version } : {}), ...(latest ? { latest } : {}), updateCommand: await updateCommand(path) };
        },
      };

      context.registerCommand("status", async (input): Promise<CodexStatusReport> => {
        const command = codexCommand();
        const source = override.current()?.source;
        const fresh = Boolean(input && typeof input === "object" && (input as { fresh?: unknown }).fresh);
        let found: { path: string; version?: string };
        try {
          if (fresh) installed = undefined;
          found = await cli();
        } catch (error) {
          return { command, ...(source ? { commandSource: source } : {}), message: error instanceof Error ? error.message : String(error) };
        }
        const version = await provider.version!().catch(() => undefined);
        const report: CodexStatusReport = {
          command,
          ...(source ? { commandSource: source } : {}),
          path: found.path,
          ...(found.version ? { version: found.version } : {}),
          ...(version?.latest ? { latest: version.latest } : {}),
          ...(version?.updateCommand ? { updateCommand: version.updateCommand } : {}),
          ...(updateAvailable(version) ? { updateAvailable: true } : {}),
          ...(found.version && compareVersions(found.version, MIN_CODEX_VERSION) < 0 ? { unsupported: true } : {}),
        };
        if (report.unsupported) return report;
        try {
          const probed = await Promise.race([
            runProbe(fresh),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Codex did not report its account within 20 s.")), 20_000).unref?.()),
          ]);
          const account = accountSummary(probed.account);
          return { ...report, ...(account ? { account } : {}), signedIn: account !== undefined, models: probed.models.length, ...(probed.codexHome ? { codexHome: probed.codexHome } : {}) };
        } catch (error) {
          return { ...report, message: error instanceof Error ? error.message : String(error) };
        }
      });
      // The executable's path from the Providers card; empty clears it.
      context.registerCommand("set-command", async (input) => {
        const requested = typeof (input as { command?: unknown } | undefined)?.command === "string" ? (input as { command: string }).command.trim() : "";
        if (override.current()?.source === "env") throw new HostCommandError(`${CODEX_COMMAND_VARIABLE} is set in Tau's environment and decides the path.`);
        if (requested && !services.findCommand(requested)) throw new HostCommandError(`No executable at "${requested}".`);
        await override.set(requested || undefined);
        installed = undefined;
        probe = undefined;
        return { command: codexCommand() };
      });
      // Each thread's running total, for the Usage kit; read from the store, never from OpenAI.
      context.registerCommand("usage", async () => ({
        threads: (await store.list()).map((entry) => {
          const model = entry.model ?? entry.observedModel;
          return { threadId: entry.tauThreadId, cwd: entry.cwd, updatedAt: entry.updatedAt, ...(model ? { model } : {}), ...(entry.usage ? { usage: { ...entry.usage } } : {}) };
        }),
      }), { callers: [USAGE_KIT_ID] });
      // Sessions the CLI ran on its own, for Onboarding to list and import as threads.
      context.registerCommand("import-scan", async () => {
        const held = await store.codexThreadIds();
        return { source: CODEX_BACKEND_KIND, ...await scanCodexSessions(codexSessionDirs(env), (id) => held.has(id)) };
      }, { long: true, callers: [ONBOARDING_KIT_ID] });
      context.registerCommand("import-sessions", async (input) => {
        const outcome = await importCodexSessions(codexSessionDirs(env), (input as { paths?: unknown } | undefined)?.paths, store);
        return { ...outcome, ...(outcome.imported.length ? { update: await services.sessions.refreshIndex() } : {}) };
      }, { long: true, callers: [ONBOARDING_KIT_ID] });
      return services.registerRuntimeBackend(provider);
    },
  };
}

export default createCodexHostExtension;
