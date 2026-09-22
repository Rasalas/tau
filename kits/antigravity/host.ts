import { existsSync } from "node:fs";
import { join } from "node:path";
import { HostCommandError, type HostBackendThreadRecord, type HostExtension, type HostExtensionServices, type HostRuntimeBackendProvider } from "tau/host-extension";
import { AntigravitySession, type AcpSelectOption } from "./acp-session.js";
import { CommandOverride } from "./command-override.js";
import { installAntigravity, resolveAntigravity, type AntigravityExecutable } from "./install.js";
import { geminiConfigDirectory, readMcpServers } from "./mcp.js";
import { browserCommand, linkUserSkills, prepareProfile, type AntigravityProfile } from "./profile.js";
import { ANTIGRAVITY_BACKEND_KIND, ANTIGRAVITY_HOST_EXTENSION_ID, ANTIGRAVITY_INSTALL_EVENT, ANTIGRAVITY_SIGN_IN_EVENT, USAGE_KIT_ID, type AntigravitySignInEvent } from "./protocol.js";
import { ANTIGRAVITY_RELEASE_VERSION, releaseAssetFor } from "./release.js";
import { createAntigravityRuntimeAdapter } from "./runtime-adapter.js";
import { AntigravitySessionStore } from "./session-store.js";
import { AntigravityThreadRuntimeBackend, type AntigravitySessionInput, type AntigravitySessionLike } from "./thread-backend.js";

export { ANTIGRAVITY_BACKEND_KIND, ANTIGRAVITY_HOST_EXTENSION_ID };

export interface AntigravityHostExtensionOptions {
  /** Opens a session (tests script one); the real one spawns Google's ACP server. */
  openSession?(input: AntigravitySessionInput & { executable: AntigravityExecutable; profile: AntigravityProfile }): Promise<AntigravitySessionLike>;
  sessionsDir?: string;
  clientVersion?: string;
  platform?: string;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  /** The user's own Gemini configuration, read for MCP servers and skills; `~/.gemini` otherwise. */
  geminiDir?: string;
}

export const ANTIGRAVITY_COMMAND_VARIABLE = "TAU_ANTIGRAVITY_ACP_COMMAND";

/**
 * Gemini through Google's own agent (ADR 0005): threads of this kind drive
 * the Antigravity ACP server, signed in with the user's Google account inside
 * that server, and persist in Tau's app data. Nothing here impersonates a
 * Google client; the binary is Google's, downloaded from Google.
 */
export function createAntigravityHostExtension(options: AntigravityHostExtensionOptions = {}): HostExtension {
  return {
    id: ANTIGRAVITY_HOST_EXTENSION_ID,
    name: "Antigravity",
    permissions: ["process", "sessions", "runtime:extend", "network"],
    activate(context) {
      const services: HostExtensionServices = context.services;
      const env = options.env ?? process.env;
      const platform = options.platform ?? process.platform;
      const arch = options.arch ?? process.arch;
      const geminiDir = options.geminiDir ?? geminiConfigDirectory();
      const adapter = createAntigravityRuntimeAdapter();
      const store = new AntigravitySessionStore({ filePath: AntigravitySessionStore.defaultPath(options.sessionsDir ?? services.sessionsDir) });
      const override = new CommandOverride(join(services.stateDir, "settings.json"), ANTIGRAVITY_COMMAND_VARIABLE, env);
      const resolveExecutable = (command = override.current()?.command) => resolveAntigravity({ override: command, stateDir: services.stateDir, platform, arch, findCommand: services.findCommand });

      /** The private home the agent runs in, with the user's own skills linked into it. */
      const prepare = async (): Promise<AntigravityProfile> => {
        const profile = await prepareProfile(services.stateDir);
        const linked = await linkUserSkills(profile, geminiDir);
        if (linked.length > 0) services.log("antigravity.skills", linked.join(", "));
        return profile;
      };

      const openSession = async (input: AntigravitySessionInput): Promise<AntigravitySessionLike> => {
        const executable = await resolveExecutable();
        const profile = await prepare();
        if (options.openSession) return options.openSession({ ...input, executable, profile });
        const mcpServers = await readMcpServers(geminiDir);
        if (mcpServers.length > 0) services.log("antigravity.mcp", mcpServers.map((server) => server.name).join(", "));
        services.noteSubprocess();
        return AntigravitySession.open({
          executable,
          profile,
          cwd: input.cwd,
          platform,
          baseEnv: env,
          browser: browserCommand(),
          clientVersion: options.clientVersion ?? "0.0.0",
          mcpServers,
          ...(input.authenticate === false ? { authenticate: false } : {}),
          onUpdate: input.onUpdate,
          onPermission: input.onPermission,
          onSignIn: input.onSignIn,
          onExit: input.onExit,
          onStderrLine: (line) => services.log("antigravity.stderr", line.slice(0, 500)),
        });
      };

      const record = (entry: Awaited<ReturnType<AntigravitySessionStore["list"]>>[number]): HostBackendThreadRecord => ({
        threadId: entry.tauThreadId,
        cwd: entry.cwd,
        ...(entry.title ? { title: entry.title } : {}),
        updatedAt: entry.updatedAt,
        messages: entry.messages,
      });

      const provider: HostRuntimeBackendProvider = {
        kind: ANTIGRAVITY_BACKEND_KIND,
        label: "Antigravity",
        adapter,
        modelProvider: "google",
        listThreads: async () => (await store.list()).map(record),
        lookup: async (threadId) => {
          const entry = await store.get(threadId);
          return entry ? record(entry) : undefined;
        },
        open: async (threadId, cwd, { resume }, thread) => {
          await resolveExecutable();
          const backend = new AntigravityThreadRuntimeBackend(threadId, cwd, {
            adapter,
            store,
            openSession,
            cachedModels: async () => (await store.listModels()).map((model): AcpSelectOption => ({ value: model.value, name: model.name })),
            onModels: (models) => void store.setModels(models.map((model) => ({ value: model.value, name: model.name }))).catch(() => undefined),
            projectName: thread.projectName,
            branch: thread.projectLabel,
            permissionLevel: thread.permissionLevel,
            onMessage: thread.onMessage,
            onEvent: thread.onEvent,
            ask: thread.ask,
            onSignIn: (link, signInThreadId) => context.emit(ANTIGRAVITY_SIGN_IN_EVENT, { threadId: signInThreadId, url: link.authorizationUrl } satisfies AntigravitySignInEvent),
          });
          await backend.start(resume ? "resume" : "create");
          return backend;
        },
        composerCommands: () => [],
        // Tau installs the release it pins; one on the PATH or named by the override is the user's to keep current.
        version: async () => {
          const executable = await resolveExecutable().catch(() => undefined);
          if (!executable) return undefined;
          const managed = executable.source === "managed" && releaseAssetFor(platform, arch) !== undefined;
          return {
            tool: "Antigravity",
            ...(executable.version ? { installed: executable.version } : {}),
            ...(managed ? { latest: ANTIGRAVITY_RELEASE_VERSION, updateCommand: "Settings → Providers → Antigravity → Update" } : {}),
          };
        },
      };

      context.registerCommand("status", async () => {
        const release = releaseAssetFor(platform, arch);
        const available = release ? ANTIGRAVITY_RELEASE_VERSION : undefined;
        const chosen = override.current();
        const command = chosen ? { command: chosen.command, commandSource: chosen.source } : {};
        try {
          const executable = await resolveExecutable();
          const profile = await prepareProfile(services.stateDir);
          return {
            kind: ANTIGRAVITY_BACKEND_KIND,
            ...command,
            installed: true,
            source: executable.source,
            version: executable.version,
            path: executable.executablePath,
            signedIn: existsSync(profile.tokenPath),
            available,
            mcpServers: (await readMcpServers(geminiDir)).map((server) => server.name),
            models: (await store.listModels()).length,
          };
        } catch (error) {
          return { kind: ANTIGRAVITY_BACKEND_KIND, ...command, installed: false, available, message: error instanceof Error ? error.message : String(error) };
        }
      });
      // The server's path from the Providers card; empty goes back to the release Tau installs.
      context.registerCommand("set-command", async (input) => {
        const requested = typeof (input as { command?: unknown } | undefined)?.command === "string" ? (input as { command: string }).command.trim() : "";
        if (override.current()?.source === "env") throw new HostCommandError(`${ANTIGRAVITY_COMMAND_VARIABLE} is set in Tau's environment and decides the path.`);
        if (requested) {
          try { await resolveExecutable(requested); } catch (error) { throw new HostCommandError(error instanceof Error ? error.message : String(error)); }
        }
        await override.set(requested || undefined);
        return { command: requested || undefined };
      });
      // Several hundred megabytes from Google; the client runs it as a host job.
      context.registerCommand("install", async () => {
        const installed = await installAntigravity({ stateDir: services.stateDir, platform, arch, onProgress: (event) => context.emit(ANTIGRAVITY_INSTALL_EVENT, event) });
        return { version: installed.version, path: installed.executablePath };
      }, { long: true });
      // Sign-out is the agent's own: it clears the credentials it stored in Tau's profile.
      context.registerCommand("logout", async () => {
        const session = await openSession({
          threadId: "sign-out",
          // No session is created, so the agent needs a directory to run in, not the workspace.
          cwd: services.stateDir,
          authenticate: false,
          onUpdate: () => undefined,
          onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
          onSignIn: () => undefined,
          onExit: () => undefined,
        });
        try {
          if (!session.logout) throw new Error("This Antigravity runtime cannot sign out.");
          await session.logout();
        } finally {
          await session.close().catch(() => undefined);
        }
        return { signedOut: true };
      }, { long: true });
      // Each thread's running total, for the Usage kit; read from the store, never from Google.
      context.registerCommand("usage", async () => ({
        threads: (await store.list()).map((entry) => {
          const model = entry.observedModel ?? entry.model;
          return {
            threadId: entry.tauThreadId,
            cwd: entry.cwd,
            updatedAt: entry.updatedAt,
            ...(model ? { model } : {}),
            ...(entry.usage ? { usage: { ...entry.usage } } : {}),
          };
        }),
      }), { callers: [USAGE_KIT_ID] });
      return services.registerRuntimeBackend(provider);
    },
  };
}

export default createAntigravityHostExtension;
