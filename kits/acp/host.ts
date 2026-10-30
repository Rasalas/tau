import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { readPersistedJson, writePersistedJson, TurnActivityStore, type AgentRuntimeAdapter, type HostBackendThreadRecord, type HostExtension, type HostRuntimeBackendProvider } from "tau/host-extension";
import { AcpSessionStore, type AcpSessionRecord } from "../_acp/session-store.js";
import { registerSessionDatabases } from "../_shared/session-database.js";
import { GenericAcpBackend } from "./thread-backend.js";
import { ACP_ID, MUSE, REGISTRY_URL, kindOf, type AcpAgentConfig, type RegistryAgent } from "./protocol.js";
import { packageAgent, parseAgent, parseRegistry } from "./config.js";
import { installBinary } from "./install.js";
import type { AcpProcess, AcpSpawnInput } from "../_acp/client.js";

export function createAcpHostExtension(options: { fetch?: typeof globalThis.fetch; spawn?(input: AcpSpawnInput): AcpProcess; env?: NodeJS.ProcessEnv } = {}): HostExtension {
  return { id: ACP_ID, name: "ACP agents", permissions: ["process", "sessions", "runtime:extend", "network"], async activate(context) {
    const services = context.services; const file = join(services.stateDir, "agents.json");
    const configs = new Map<string, AcpAgentConfig>();
    const providers = new Map<string, { stop(): void; store: AcpSessionStore; activity: TurnActivityStore }>();
    const saved = (await readPersistedJson<{ agents: unknown[] }>(file, { expectedVersion: 1, invalidJson: "reject", decode: value => { const data = value as { agents?: unknown }; return Array.isArray(data?.agents) ? { agents: data.agents } : undefined; } }))?.data;
    for (const raw of saved?.agents ?? []) { const config = parseAgent(raw); configs.set(config.id, config); }
    if (!configs.has(MUSE.id)) configs.set(MUSE.id, MUSE);
    const persist = () => writePersistedJson(file, 1, { agents: [...configs.values()] });
    const record = (entry: AcpSessionRecord & { messageCount?: number }): HostBackendThreadRecord => ({ threadId: entry.tauThreadId, cwd: entry.cwd, updatedAt: entry.updatedAt, messages: entry.messages, title: entry.title, createdAt: entry.createdAt, messageCount: entry.messageCount, ...(entry.model ?? entry.observedModel ? { model: { provider: entry.backendKind, id: (entry.model ?? entry.observedModel)! } } : {}) });
    const register = (config: AcpAgentConfig) => {
      const previous = providers.get(config.id);
      const store = previous?.store ?? new AcpSessionStore({ filePath: join(services.stateDir, `${config.id}-sessions.json`), backendKind: kindOf(config.id), agent: config.name });
      const activity = previous?.activity ?? new TurnActivityStore({ directory: join(services.stateDir, `${config.id}-activity`) });
      previous?.stop();
      const adapter: AgentRuntimeAdapter = { id: kindOf(config.id), capabilities: { skillInvocationDialect: "acp", ownsModelSelection: false, interactiveApprovals: true, fileAttachments: true }, transport: { sendPrompt: async () => { throw new Error("ACP threads use their backend."); }, abort: async () => undefined } };
      const provider: HostRuntimeBackendProvider = {
        kind: adapter.id, label: config.name, order: 80, adapter, ownPlan: true,
        listThreads: async () => (await store.listMetadata()).map(record),
        lookup: async id => { const entry = await store.get(id); return entry ? record(entry) : undefined; },
        removeThread: async id => { const taken = await store.take(id); return taken ? { ...taken, activity: await activity.take(id) } : undefined; },
        restoreThread: async (id, value) => { await store.put(id, value); await activity.put(id, (value as { activity?: unknown })?.activity); },
        composerCommands: () => [],
        newThreadCatalog: async () => {
          if (!services.findCommand(config.command)) return { models: [], thinkingLevels: {}, status: "not-installed", note: `Install ${config.command} or set its path in Settings → ACP agents.` };
          const models = await store.listModels();
          const ids = [...new Set([...models.map(model => model.id), ...config.models ?? []])];
          return { models: ids.map(id => ({ provider: config.id, id, name: models.find(model => model.id === id)?.name ?? id })), thinkingLevels: {} };
        },
        open: async (id, cwd, { resume }, thread) => {
          const path = services.findCommand(config.command);
          if (!path) throw new Error(`${config.command} is not installed. Set its path in Settings → ACP agents.`);
          const backend = new GenericAcpBackend(id, cwd, { ...thread, config: { ...config, command: path }, store, activity, adapter, env: options.env ?? process.env, mcp: () => services.mcp.connect({ sessionId: id, cwd, nativeCapabilities: ["background-work"] }), ...(options.spawn ? { spawn: options.spawn } : {}) });
          await backend.start(resume ? "resume" : "create"); return backend;
        },
      };
      providers.set(config.id, { stop: services.registerRuntimeBackend(provider), store, activity });
    };
    registerSessionDatabases(context, () => [...providers.values()].map(provider => provider.store.database));
    for (const config of configs.values()) register(config);
    let registry: RegistryAgent[] | undefined;
    const report = () => ({ agents: [...configs.values()] });
    context.registerCommand("list", report, { access: "owner" });
    context.registerCommand("registry", async () => {
      const response = await (options.fetch ?? fetch)(REGISTRY_URL, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`ACP registry unavailable: HTTP ${response.status}. You can still add an agent manually.`);
      const text = await response.text();
      if (text.length > 4 * 1024 * 1024) throw new Error("The ACP registry is too large.");
      registry = parseRegistry(JSON.parse(text)); return registry;
    }, { access: "owner", long: true });
    context.registerCommand("save", async raw => {
      const config = parseAgent(raw);
      if ((await providers.get(config.id)?.store.listMetadata())?.length) throw new Error("This agent has saved threads. Add a new ID to change its launch configuration.");
      const old = configs.get(config.id); configs.set(config.id, config);
      try { await persist(); } catch (error) { if (old) configs.set(config.id, old); else configs.delete(config.id); throw error; }
      register(config); context.emit("agents", report()); return report();
    }, { access: "owner" });
    context.registerCommand("install", async raw => {
      const id = (raw as { id?: string })?.id;
      const agent = registry?.find(entry => entry.id === id);
      if (!agent) throw new Error("Refresh the registry and choose an agent.");
      if (configs.has(agent.id)) throw new Error("That agent is already configured.");
      await mkdir(services.stateDir, { recursive: true });
      const config = packageAgent(agent) ?? await installBinary(agent, services.stateDir, options.fetch ?? fetch);
      configs.set(config.id, config);
      try { await persist(); } catch (error) { configs.delete(config.id); throw error; }
      register(config); context.emit("agents", report()); return report();
    }, { access: "owner", long: true });
    context.registerCommand("remove", async raw => {
      const id = (raw as { id?: string })?.id; const config = id ? configs.get(id) : undefined;
      if (!config || id === MUSE.id) throw new Error("Choose a custom ACP agent to remove.");
      const provider = providers.get(id!);
      if ((await provider?.store.listMetadata())?.length) throw new Error("Delete this agent's threads before removing it.");
      configs.delete(id!); try { await persist(); } catch (error) { configs.set(id!, config); throw error; }
      provider?.stop(); await provider?.store.flushAndRelease(); providers.delete(id!);
      context.emit("agents", report()); return report();
    }, { access: "owner" });
    return async () => { for (const provider of providers.values()) provider.stop(); await Promise.all([...providers.values()].map(provider => provider.store.flushAndRelease())); };
  } };
}
export default createAcpHostExtension;
