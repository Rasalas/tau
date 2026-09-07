import { existsSync } from "node:fs";
import type { HostBackendThreadRecord, HostExtension, HostExtensionServices, HostRuntimeBackendProvider } from "tau/host-extension";
import { AntigravitySession, type AcpSelectOption } from "./acp-session.js";
import { installAntigravity, resolveAntigravity, type AntigravityExecutable } from "./install.js";
import { browserCommand, prepareProfile, type AntigravityProfile } from "./profile.js";
import { ANTIGRAVITY_BACKEND_KIND, ANTIGRAVITY_HOST_EXTENSION_ID, ANTIGRAVITY_INSTALL_EVENT, ANTIGRAVITY_SIGN_IN_EVENT, type AntigravitySignInEvent } from "./protocol.js";
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
}

const overrideCommand = (env: NodeJS.ProcessEnv) => env.TAU_ANTIGRAVITY_ACP_COMMAND;

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
      const adapter = createAntigravityRuntimeAdapter();
      const store = new AntigravitySessionStore({ filePath: AntigravitySessionStore.defaultPath(options.sessionsDir ?? services.sessionsDir) });
      const resolveExecutable = () => resolveAntigravity({ override: overrideCommand(env), stateDir: services.stateDir, platform, arch, findCommand: services.findCommand });
      let modelCache: AcpSelectOption[] = [];

      const openSession = async (input: AntigravitySessionInput): Promise<AntigravitySessionLike> => {
        const executable = await resolveExecutable();
        const profile = await prepareProfile(services.stateDir);
        if (options.openSession) return options.openSession({ ...input, executable, profile });
        services.noteSubprocess();
        const session = await AntigravitySession.open({
          executable,
          profile,
          cwd: input.cwd,
          platform,
          baseEnv: env,
          browser: browserCommand(),
          clientVersion: options.clientVersion ?? "0.0.0",
          onUpdate: input.onUpdate,
          onPermission: input.onPermission,
          onSignIn: input.onSignIn,
          onExit: input.onExit,
          onStderrLine: (line) => services.log("antigravity.stderr", line.slice(0, 500)),
        });
        return session;
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
            openSession: async (input) => {
              const session = await openSession(input);
              modelCache = session.modelOptions();
              return session;
            },
            cachedModels: async () => modelCache,
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
      };

      context.registerCommand("status", async () => {
        try {
          const executable = await resolveExecutable();
          const profile = await prepareProfile(services.stateDir);
          return { kind: ANTIGRAVITY_BACKEND_KIND, installed: true, source: executable.source, version: executable.version, path: executable.executablePath, signedIn: existsSync(profile.tokenPath) };
        } catch (error) {
          return { kind: ANTIGRAVITY_BACKEND_KIND, installed: false, message: error instanceof Error ? error.message : String(error) };
        }
      });
      // A download of several hundred megabytes; the client runs it as a host job.
      context.registerCommand("install", async () => {
        const installed = await installAntigravity({ stateDir: services.stateDir, platform, arch, onProgress: (event) => context.emit(ANTIGRAVITY_INSTALL_EVENT, event) });
        return { version: installed.version, path: installed.executablePath };
      }, { long: true });
      return services.registerRuntimeBackend(provider);
    },
  };
}

export default createAntigravityHostExtension;
