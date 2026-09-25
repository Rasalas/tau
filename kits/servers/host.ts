import type { HostExtension } from "tau/host-extension";
import { CredentialAskpassSource, ServerCredentials, registerCredentialCommands } from "./credentials.js";
import { registerServerProjects } from "./projects.js";
import { ServerNetwork } from "./network-policy.js";
import { NetworkSandbox, createPiNetworkExtension } from "./pi-network.js";
import { ServerPrompts } from "./prompts.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import { ServerSsh } from "./ssh-service.js";
import { ServersStore } from "./store.js";
import { gitCall } from "./sync/git.js";
import { SyncService } from "./sync/service.js";
import { ServerTargets } from "./targets.js";

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
      const targets = new ServerTargets({ services, store });
      targets.register(context);
      const prompts = new ServerPrompts((event, payload) => context.emit(event, payload));
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
        credentialSources: [new CredentialAskpassSource(credentials, lookup)],
        lookupTarget: async (cwd, targetId) => (await lookup(cwd, targetId)).target,
      });
      ssh.register();
      const sync = new SyncService(context, {
        store,
        target: (cwd, targetId) => targets.target(cwd, targetId),
        transport: (input) => ssh.transport(input),
        git: gitCall("git", () => services.noteSubprocess()),
      });
      sync.register();
      const stopProjects = registerServerProjects(context, { store, targets, ssh, sync });
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
        stopProjects();
        sync.dispose();
        withdraw?.();
        unregisterPi?.();
        prompts.dispose();
        await ssh.dispose();
        await sandbox.dispose();
      };
    },
  };
}

export default createServersHostExtension;
