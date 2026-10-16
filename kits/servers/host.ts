import { HostCommandError, type HostExtension } from "tau/host-extension";
import { ServerAgentTools, registerServerAgentTools } from "./agent-tools.js";
import { HistoryCleanup } from "./cleanup.js";
import { CredentialAskpassSource, ServerCredentials, registerCredentialCommands } from "./credentials.js";
import { DeployService } from "./deploy.js";
import { DriftService, WORKSPACE_KIT_ID } from "./drift.js";
import { ServerFtp } from "./ftp-service.js";
import { registerServerProjects } from "./projects.js";
import { ServerNetwork } from "./network-policy.js";
import { NetworkSandbox, createPiNetworkExtension } from "./pi-network.js";
import { ServerPrompts } from "./prompts.js";
import { SERVERS_EXTENSION_ID, TARGET_LEVELS, type TargetLevel } from "./protocol.js";
import { RollbackService } from "./rollback.js";
import { ServerSsh } from "./ssh-service.js";
import { createServerStatus } from "./status-host.js";
import { MainCheckouts, ServersStore } from "./store.js";
import { gitCall } from "./sync/git.js";
import { readTargetFile } from "./target-settings.js";
import { SyncService } from "./sync/service.js";
import { ServerTargets } from "./targets.js";
import { ConnectionConsent, connectionFingerprint } from "./connection-consent.js";
import { updateTargetFile } from "./target-settings.js";
import { ServerFolders } from "./folders.js";

const ACCESS_KIT_ID = "tau.access";

/**
 * Servers: a server reached over SSH/SFTP or FTP as a project's work target
 * (ADR 0028). The agent works on the local copy; the user deploys by hand.
 */
export function createServersHostExtension(): HostExtension {
  return {
    id: SERVERS_EXTENSION_ID,
    name: "Servers",
    permissions: ["process", "network", "sessions", "runtime:extend", "workspace:read", "workspace:write"],
    isolation: "in-process",
    activate(context) {
      const { services } = context;
      const logger = { warn: (message: string) => services.log("servers.store", message) };
      const store = new ServersStore(services.stateDir, logger);
      // One answer per folder for every reader: Git is asked once, not at each start-up hook.
      const checkouts = new MainCheckouts();
      const targets = new ServerTargets({ services, store, checkouts });
      targets.register(context);
      const prompts = new ServerPrompts((event, payload) => context.emit(event, payload), () => (services.clients?.count() ?? 0) > 0);
      const consent = new ConnectionConsent(prompts, {
        read: async (cwd, target) => {
          const project = await targets.project(cwd);
          const file = await readTargetFile(store, { workspaceId: project.workspaceId, targetId: target.id });
          return typeof file.connectionGrant === "string" ? file.connectionGrant : undefined;
        },
        write: async (cwd, target, fingerprint) => {
          const project = await targets.project(cwd);
          await updateTargetFile(store, { workspaceId: project.workspaceId, targetId: target.id }, (file) => ({ ...file, connectionGrant: fingerprint }));
        },
      });
      context.registerCommand("authorize-server", async (raw) => {
        const input = (raw ?? {}) as Record<string, unknown>;
        const { target } = await targets.target(input.cwd, input.targetId);
        if (typeof input.cwd !== "string" || input.fingerprint !== connectionFingerprint(target)) throw new HostCommandError("The server settings changed. Review the new address before continuing.");
        await consent.grant(input.cwd, target);
        return { authorized: true };
      }, { audit: { label: "allowed the project's server connection" } });
      const stopPromptClients = services.clients?.observe({ detached: () => prompts.surfaceChanged() });
      const credentials = new ServerCredentials({
        prompts,
        targetsDir: store.targetsDir,
        findCommand: (name) => services.findCommand(name),
        logger,
        log: (event, message) => services.log(event, message),
      });
      const lookup = (cwd: unknown, targetId: unknown) => targets.target(cwd, targetId);
      registerCredentialCommands(context, credentials, prompts, lookup, (cwd) => targets.list(cwd));
      const ssh = new ServerSsh(context, {
        prompts,
        consent,
        credentialSources: [new CredentialAskpassSource(credentials, lookup)],
        lookupTarget: async (cwd, targetId) => (await lookup(cwd, targetId)).target,
      });
      ssh.register();
      const ftp = new ServerFtp(context, { prompts, consent, credentials, store, lookupTarget: lookup });
      ftp.register();
      // The transport by the target's protocol; everything above it is the same.
      const transport = async (input: { cwd: string; targetId: string }) =>
        (await lookup(input.cwd, input.targetId)).target.protocol === "ftp" ? ftp.transport(input) : ssh.transport(input);
      const git = gitCall("git", () => services.noteSubprocess());
      const sync = new SyncService(context, {
        store,
        target: (cwd, targetId) => targets.target(cwd, targetId),
        transport,
        git,
        withSignal: (signal, run) => prompts.withSignal(signal, run),
        cancelTransport: async ({ cwd, targetId }) => {
          const workspace = await services.knownWorkspacePath(cwd);
          await Promise.all([ssh.connections.closeTarget(workspace, targetId), ftp.connections.closeTarget(workspace, targetId)]);
        },
      });
      sync.register();
      const folders = new ServerFolders(store, sync);
      folders.register(context);
      const drift = new DriftService(context, {
        store,
        list: (cwd) => targets.list(cwd),
        sync,
        workspace: (command, input) => context.invokeHostExtension(WORKSPACE_KIT_ID, command, input),
        git,
      });
      drift.register();
      const deploy = new DeployService(context, {
        store,
        sync,
        target: (cwd, targetId) => targets.target(cwd, targetId),
        drift: { state: (cwd) => drift.state(cwd), settled: (key, root, paths) => drift.settled(key, root, paths) },
        git,
        folders,
      });
      deploy.register();
      new RollbackService(context, { store, sync, deploy, git }).register();
      const cleanup = new HistoryCleanup(context, { store, sync, list: (cwd) => targets.list(cwd), git });
      cleanup.register();
      cleanup.start();
      const status = createServerStatus(context, { store, targets, sync, ssh, transport, drift, deploy, git });
      status.register();
      const stopProjects = registerServerProjects(context, { store, targets, ssh, sync });
      // Before the network extension: its hook rewrites bash, and the bypass check reads the command as the model wrote it.
      const stopAgentTools = registerServerAgentTools(context, new ServerAgentTools({
        list: (cwd) => targets.list(cwd),
        transport,
        status: (input) => status.status(input),
        preview: (input) => deploy.preview(input),
        targetLevel: async (key) => (await readTargetFile(store, key)).level,
        threadLevel: async (threadId) => {
          const level = await context.invokeHostExtension(ACCESS_KIT_ID, "thread-level-of", { threadId });
          // Servers has no reviewer: a thread at `auto` asks as at `ask`.
          if (level === "auto") return "ask";
          return (TARGET_LEVELS as readonly unknown[]).includes(level) ? level as TargetLevel : undefined;
        },
        mirrorDir: (key) => store.mirrorDir(key),
        git,
        log: (label, detail) => services.log(label, detail),
      }));
      const sandbox = new NetworkSandbox({
        load: () => services.loadDependency("@anthropic-ai/sandbox-runtime"),
        ripgrep: () => services.findCommand("rg"),
        log: (label, detail) => services.log(label, detail),
      });
      const policies = services.executionPolicy;
      const network = new ServerNetwork({
        services,
        store,
        logger,
        checkouts,
        ...(policies ? { changed: (cwd: string) => policies.changed(cwd) } : {}),
        piEnforcement: () => sandbox.availability(),
      });
      network.register(context);
      // An older host has no policy seam; nothing there would read the limit.
      const withdraw = policies?.provide((cwd) => network.rule(cwd));
      const unregisterPi = policies
        ? services.registerRuntimeExtension("tau-servers-network", createPiNetworkExtension({ policy: (cwd) => policies.for(cwd), sandbox }))
        : undefined;
      return async () => {
        status.dispose();
        await cleanup.dispose();
        drift.dispose();
        stopProjects();
        stopAgentTools();
        sync.dispose();
        withdraw?.();
        unregisterPi?.();
        stopPromptClients?.();
        prompts.dispose();
        await ssh.dispose();
        await ftp.dispose();
        await sandbox.dispose();
      };
    },
  };
}

export default createServersHostExtension;
