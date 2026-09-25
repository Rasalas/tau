import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { HostCommandError, THREAD_TEXTS_COMMAND, TurnActivityStore, registerSignIn, threadTextsDelta, type HostBackendThreadRecord, type SignInFlowContext, type HostExtension, type HostExtensionServices, type HostRuntimeBackendProvider } from "tau/host-extension";
import { AntigravitySession, type AcpSelectOption } from "./acp-session.js";
import { CommandOverride } from "./command-override.js";
import { installAntigravity, resolveAntigravity, type AntigravityExecutable } from "./install.js";
import { geminiConfigDirectory, readMcpServers, withTauServer, type AcpMcpServer } from "./mcp.js";
import { browserCommand, linkUserSkills, prepareProfile, profileTokenPath, type AntigravityAuthMethod, type AntigravityProfile, type AuthorizationLink } from "./profile.js";
import { ANTIGRAVITY_BACKEND_KIND, ANTIGRAVITY_HOST_EXTENSION_ID, ANTIGRAVITY_INSTALL_EVENT, ANTIGRAVITY_SIGN_IN_EVENT, SEARCH_KIT_ID, USAGE_KIT_ID, type AntigravitySignInEvent } from "./protocol.js";
import { ANTIGRAVITY_RELEASE_VERSION, releaseAssetFor } from "./release.js";
import { createAntigravityRuntimeAdapter } from "./runtime-adapter.js";
import { AntigravitySessionStore } from "./session-store.js";
import { AntigravitySignInSettings, METHOD_LABELS, antigravityAccount, antigravitySignInMethods, callbackAddress, credentialEnvironment, methodProblem, usesBrowser } from "./sign-in.js";
import { AntigravityThreadRuntimeBackend, MODEL_PROVIDER, type AntigravitySessionInput, type AntigravitySessionLike } from "./thread-backend.js";

export { ANTIGRAVITY_BACKEND_KIND, ANTIGRAVITY_HOST_EXTENSION_ID };

export interface AntigravityHostExtensionOptions {
  /** Opens a session (tests script one); the real one spawns Google's ACP server. */
  openSession?(input: AntigravitySessionInput & { executable: AntigravityExecutable; profile: AntigravityProfile; mcpServers: readonly AcpMcpServer[] }): Promise<AntigravitySessionLike>;
  sessionsDir?: string;
  clientVersion?: string;
  platform?: string;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  /** The user's own Gemini configuration, read for MCP servers and skills; `~/.gemini` otherwise. */
  geminiDir?: string;
  /** Reaches the agent's loopback listener with an address the user pasted; tests answer it. */
  fetch?: typeof globalThis.fetch;
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
      const storePath = AntigravitySessionStore.defaultPath(options.sessionsDir ?? services.sessionsDir);
      const store = new AntigravitySessionStore({ filePath: storePath });
      const activity = new TurnActivityStore({ directory: join(dirname(storePath), "antigravity-activity") });
      const override = new CommandOverride(join(services.stateDir, "settings.json"), ANTIGRAVITY_COMMAND_VARIABLE, env);
      const resolveExecutable = (command = override.current()?.command) => resolveAntigravity({ override: command, stateDir: services.stateDir, platform, arch, findCommand: services.findCommand });
      const signInSettings = new AntigravitySignInSettings(join(services.stateDir, "sign-in.json"));

      /** The private home the agent runs in, with the user's own skills linked into it. */
      const prepare = async (): Promise<AntigravityProfile> => {
        const choice = signInSettings.current;
        const profile = await prepareProfile(services.stateDir, choice.method, { ...(choice.gcpProject ? { project: choice.gcpProject } : {}), ...(choice.gcpLocation ? { location: choice.gcpLocation } : {}) });
        const linked = await linkUserSkills(profile, geminiDir);
        if (linked.length > 0) services.log("antigravity.skills", linked.join(", "));
        return profile;
      };

      const openSession = async (input: AntigravitySessionInput): Promise<AntigravitySessionLike> => {
        const executable = await resolveExecutable();
        const profile = await prepare();
        // A sign-out starts no session, so it has no thread to reach Tau's tools for.
        const tau = input.authenticate === false ? undefined : await services.mcp.connect({ sessionId: input.threadId, cwd: input.cwd }).catch(() => undefined);
        const mcpServers = withTauServer(await readMcpServers(geminiDir), tau);
        if (options.openSession) return options.openSession({ ...input, executable, profile, mcpServers });
        const choice = signInSettings.current;
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
          authMethod: choice.method,
          credentials: credentialEnvironment(env, choice),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.authenticate === false ? { authenticate: false } : {}),
          onUpdate: input.onUpdate,
          onPermission: input.onPermission,
          ...(input.onElicitation ? { onElicitation: input.onElicitation } : {}),
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
        order: 30,
        adapter,
        modelProvider: "google",
        listThreads: async () => (await store.list()).map(record),
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
          return entry ? record(entry) : undefined;
        },
        open: async (threadId, cwd, { resume }, thread) => {
          await resolveExecutable();
          const backend = new AntigravityThreadRuntimeBackend(threadId, cwd, {
            adapter,
            store,
            activity,
            openSession,
            cachedModels: async () => (await store.listModels()).map((model): AcpSelectOption => ({ value: model.value, name: model.name })),
            onModels: (models) => void store.setModels(models.map((model) => ({ value: model.value, name: model.name }))).catch(() => undefined),
            projectName: thread.projectName,
            branch: thread.projectLabel,
            permissionLevel: thread.permissionLevel,
            ...(thread.executionPolicy ? { executionPolicy: thread.executionPolicy } : {}),
            onMessage: thread.onMessage,
            onEvent: thread.onEvent,
            ask: thread.ask,
            ...(thread.priceUsage ? { priceUsage: thread.priceUsage } : {}),
            onSignIn: (link, signInThreadId) => context.emit(ANTIGRAVITY_SIGN_IN_EVENT, { threadId: signInThreadId, url: link.authorizationUrl } satisfies AntigravitySignInEvent),
          });
          await backend.start(resume ? "resume" : "create");
          return backend;
        },
        composerCommands: () => [],
        // The server names its models only in a session; a draft offers the ones the last session named.
        newThreadCatalog: async () => {
          const models = (await store.listModels()).map((model) => ({ provider: MODEL_PROVIDER, id: model.value, name: model.name.trim() || model.value }));
          return models.length > 0
            ? { models, thinkingLevels: {} }
            : { models: [], thinkingLevels: {}, note: "Antigravity names its models once a thread has started; choose one then." };
        },
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
          const choice = signInSettings.current;
          const account = antigravityAccount(choice, existsSync(profileTokenPath(services.stateDir)), env);
          return {
            kind: ANTIGRAVITY_BACKEND_KIND,
            ...command,
            installed: true,
            source: executable.source,
            version: executable.version,
            path: executable.executablePath,
            signedIn: account.signedIn,
            authMethod: choice.method,
            ...(choice.gcpProject ? { gcpProject: choice.gcpProject } : {}),
            ...(choice.gcpLocation ? { gcpLocation: choice.gcpLocation } : {}),
            ...(account.signedIn && account.label ? { account: account.label } : {}),
            available,
            mcpServers: (await readMcpServers(geminiDir)).map((server) => server.name),
            models: (await store.listModels()).length,
          };
        } catch (error) {
          return { kind: ANTIGRAVITY_BACKEND_KIND, ...command, installed: false, available, message: error instanceof Error ? error.message : String(error) };
        }
      }, { access: "read" });
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
      const logout = async () => {
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
      };
      context.registerCommand("logout", async () => { await logout(); return { signedOut: true }; }, { long: true });
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
            ...(entry.usageTurns ? { turns: entry.usageTurns } : {}),
          };
        }),
      }), { access: "read", callers: [USAGE_KIT_ID] });
      // What each thread said, for Search Kit to find threads nobody has open; only what it lacks.
      context.registerCommand(THREAD_TEXTS_COMMAND, async (input) => threadTextsDelta(await store.list(), input), { long: true, callers: [SEARCH_KIT_ID] });

      // Signing in from the window: the agent's own `authenticate` for the chosen method, its link shown to open.
      const fetchUrl = options.fetch ?? globalThis.fetch;
      const reachLoopback = (link: AuthorizationLink, flow: SignInFlowContext) => {
        let question = "If the page after Google's does not load (a browser on another computer), paste its address here.";
        const listen = async (): Promise<void> => {
          for (;;) {
            const pasted = await flow.ask({ kind: "code", message: question, placeholder: link.redirectUri });
            try {
              await fetchUrl(callbackAddress(pasted, link), { redirect: "manual", signal: flow.signal });
              return;
            } catch (error) {
              question = `${error instanceof Error ? error.message : String(error)} Paste the address again.`;
            }
          }
        };
        void listen().catch(() => undefined);
      };
      let unregister = services.registerRuntimeBackend(provider);
      const signIn = registerSignIn(context, {
        report: async () => {
          const choice = signInSettings.current;
          const missing = await resolveExecutable().then(() => undefined, () => "Install Antigravity first.");
          return {
            methods: antigravitySignInMethods(choice, env, missing),
            account: antigravityAccount(choice, existsSync(profileTokenPath(services.stateDir)), env),
            note: "The agent keeps its Google sign-in in Tau's Antigravity profile, and a key stays in your shell's environment; Tau stores none.",
          };
        },
        signIn: async (_target, method, flow) => {
          const chosen = method as AntigravityAuthMethod;
          const problem = methodProblem(chosen, signInSettings.current, env);
          if (problem) throw new Error(problem);
          await signInSettings.save({ method: chosen });
          if (!usesBrowser(chosen)) flow.verifying(`Connecting with the ${METHOD_LABELS[chosen]}…`);
          const session = await openSession({
            threadId: "sign-in",
            // No session is created, so the agent needs a directory to run in, not the workspace.
            cwd: services.stateDir,
            signal: flow.signal,
            onUpdate: () => undefined,
            onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
            onSignIn: (link) => {
              flow.show({ browser: { url: link.authorizationUrl, instructions: "Sign in with Google in the browser; the agent finishes the sign-in by itself on this computer." } });
              reachLoopback(link, flow);
            },
            onExit: () => undefined,
          });
          await session.close().catch(() => undefined);
          return `Signed in with the ${METHOD_LABELS[chosen]}.`;
        },
        signOut: async () => {
          const choice = signInSettings.current;
          if (!usesBrowser(choice.method)) {
            await signInSettings.save({ method: "oauth-personal" });
            return `Antigravity no longer uses the ${METHOD_LABELS[choice.method]}; it signs in with a Google account again.`;
          }
          await logout();
          return "Signed out of Antigravity.";
        },
        // The account decides what a session may do: the backend is registered anew and its catalog asked again.
        changed: () => {
          unregister();
          unregister = services.registerRuntimeBackend(provider);
        },
      });
      // The Google Cloud project Enterprise and Agent Platform run in; not a credential.
      context.registerCommand("set-sign-in", async (input) => {
        const { gcpProject, gcpLocation } = (input ?? {}) as { gcpProject?: unknown; gcpLocation?: unknown };
        try {
          await signInSettings.save({ gcpProject: typeof gcpProject === "string" ? gcpProject : "", gcpLocation: typeof gcpLocation === "string" ? gcpLocation : "" });
        } catch (error) {
          throw new HostCommandError(error instanceof Error ? error.message : String(error));
        }
        await signIn.publish();
        return signInSettings.current;
      });
      return () => {
        signIn.dispose();
        unregister();
      };
    },
  };
}

export default createAntigravityHostExtension;
