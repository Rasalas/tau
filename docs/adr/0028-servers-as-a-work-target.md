# ADR 0028: Servers as a work target: work locally, deploy by hand, no agent on the server

## Status

Accepted, 2026-09-25. The Servers kit (`kits/servers/`, id `tau.servers`)
implements it over the tickets of wave I.

## Context

Many projects still live on a server that is reached over SSH/SFTP or FTP: a
PHP site, a WordPress install, a shop. Several of the user's projects keep the
connection in `.vscode/sftp.json` (the SFTP extension and its forks, one of
which keeps the password in the macOS keychain, the editor's secret store or a
password manager). The user edits a local copy, checks it, uploads it, checks
it on the server and undoes the upload if it went wrong.

The server is also a source of changes: a colleague edits a file live and
commits nothing. A Git repository on the server, if there is one, is often
behind what is deployed.

"Host" and "remote" already name Tau's own host and a remote Tau host
(`CONTEXT.md`), so this work uses its own words: server target, mirror state,
server drift and deployment.

## Decision

1. **No agent on the server.** Tau installs nothing there and puts no
   credentials or model access on it. The agent works on the local copy with
   its normal tools. SSH goes through the system's `ssh` with the user's
   `~/.ssh/config` and local agent. SFTP runs over that same connection. FTP
   and FTPS are a second transport, with fewer capabilities.
2. **Uploads are manual.** Only the user uploads, ideally after running and
   testing locally. The agent may propose an upload as a card in the
   transcript, but it never uploads or rolls back itself.
3. **Every upload is a deployment.** Before writing, Tau reads the target files
   again and keeps them as the backup. If a file changed on the server since it
   was last read, Tau does not overwrite it and offers a three-way comparison
   instead. Each deployment can be rolled back on its own, and a rollback is a
   deployment too. The history stays after the change is committed; a commit
   only marks the deployment as done. Old history is removed by age and count.
4. **Server drift becomes a branch.** Tau compares the server with the mirror
   state (what it last read there). Drift is committed on
   `server-drift/<date>`, with HEAD as the parent and only the drifted paths
   changed. Tau never merges it on its own; merging takes a click.
5. **Git on the server is read-only.** `.git/` is never read or written by a
   sync, and Tau shows the server's Git state only with
   `--no-optional-locks`. `server_exec` refuses Git subcommands that write, at
   every level.
6. **Commands on the server follow a target level.** Reading `remotePath` and
   `~/tmp` is free. Commands and writes to `~/tmp` follow the stricter of the
   target level (read-only, ask, full; default ask) and the thread's access
   level. `~/tmp` is the only scratch area beside the project folder.
7. **Nothing in the project.** Tau writes no `.tau/` folder into a server
   project. Targets, the mirror state, deployments, backups and trust
   decisions live in the kit's state folder,
   `<userData>/kit-state/tau.servers/targets/<workspaceId>/<targetId>/`. The
   key is the workspace id of the main checkout, so a project's worktrees share
   its targets. Files are 0600 and written atomically. The kit's settings exist
   on this machine's level only, because a project level would create
   `.tau/config.json`.
8. **Read the standards that exist.** Tau reads `.vscode/sftp.json` (every
   variant, profiles and contexts included) and the SSH config. It writes a
   `sftp.json` only when the user asks, and never with a password in it.
   Passwords come from the keychain item the extension already made, from a
   command the user approved for the project, or from a single question.
   Tau never writes a password to a file.
9. **Local runs stay off the live system.** A project on a server often holds
   live credentials in its config files. For server projects, the agent's
   local execution may reach only localhost and approved package sources
   unless the user allows more for that project. Tau detects such files and
   deselects them in a deployment. The core seam for this
   (`services.executionPolicy`) is generic and knows nothing about servers.

## Consequences

- Everything specific to servers is a kit. Core gains only the generic
  execution-policy seam. Writing Git objects in the project (the drift branch,
  a repository from a downloaded tree) goes through Workspace Kit commands
  with `callers: ["tau.servers"]` (ADR 0020). The thread's access level comes
  from an Access Kit command in the same way.
- A project moved on disk gets a new workspace id. Tau then offers to link it
  to the known target by host and remote path.
- A server edit that lands between Tau's last read and its rename can still
  be overwritten. The per-target lock narrows that window but cannot close it
  on a server Tau does not control.
- Runtimes that cannot enforce a localhost-only network (and Windows, which
  has no sandbox) refuse to run in a server project until the user approves
  that project.
- Tests never reach a real server, keychain, SSH config or `sftp.json`. They
  use loopback fakes, and `TAU_SERVERS_LOOPBACK_ONLY=1` refuses any other
  target.
