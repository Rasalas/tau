import type { HostExtension } from "tau/host-extension";
import { CredentialAskpassSource, ServerCredentials, registerCredentialCommands } from "./credentials.js";
import { ServerPrompts } from "./prompts.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import { ServerSsh } from "./ssh-service.js";
import { createServerStatus } from "./status-host.js";
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
    permissions: ["process", "network", "sessions", "runtime:extend", "workspace:read"],
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
      const git = gitCall("git", () => services.noteSubprocess());
      const sync = new SyncService(context, {
        store,
        target: (cwd, targetId) => targets.target(cwd, targetId),
        transport: (input) => ssh.transport(input),
        git,
      });
      sync.register();
      const status = createServerStatus(context, { store, targets, sync, ssh, git });
      status.register();
      return async () => {
        status.dispose();
        sync.dispose();
        prompts.dispose();
        await ssh.dispose();
      };
    },
  };
}

export default createServersHostExtension;
