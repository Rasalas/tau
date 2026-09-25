import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import type { DriftService } from "./drift.js";
import type { ServerSsh } from "./ssh-service.js";
import { ensureControlDir } from "./ssh-target.js";
import { sshTerminalCommand } from "./ssh-terminal.js";
import { ServerStatusService } from "./status.js";
import type { ServersStore } from "./store.js";
import type { GitCall } from "./sync/git.js";
import type { SyncService } from "./sync/service.js";
import type { ServerTargets } from "./targets.js";

/** The server view's host side, on the kit's targets, sync and SSH connections. */
export function createServerStatus(context: HostExtensionContext, parts: {
  store: ServersStore;
  targets: ServerTargets;
  sync: SyncService;
  ssh: ServerSsh;
  drift: DriftService;
  git: GitCall;
}): ServerStatusService {
  const { services } = context;
  return new ServerStatusService(context, {
    store: parts.store,
    git: parts.git,
    list: (cwd) => parts.targets.list(cwd),
    compare: (input) => parts.sync.compare(input),
    transport: (input) => parts.ssh.transport(input),
    drift: {
      state: (cwd) => parts.drift.state(cwd),
      check: (input) => parts.drift.check(input, { quiet: true }),
    },
    async terminalCommand(input) {
      const transport = await parts.ssh.transport(input);
      const ssh = services.findCommand("ssh");
      if (!ssh) throw new HostCommandError("ssh is not on this machine's PATH.");
      const controlDir = process.platform === "win32" ? undefined : await ensureControlDir();
      const workspace = await services.knownWorkspacePath(input.cwd);
      return sshTerminalCommand({ ssh, target: transport.target, root: transport.root, baseDir: workspace, ...(controlDir ? { controlDir } : {}) });
    },
  });
}
