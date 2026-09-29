# Servers as a work target

For a site that lives on a server you reach over SSH, SFTP, FTP or FTPS. The agent works on a local copy; nothing goes to the server until you click Upload.

- **Start.** Add project → From a server… downloads a folder over SSH into a new Git repository whose first commit is the server's state. A folder that already has a `.vscode/sftp.json` (the VS Code SFTP extension's file, profiles included) gets that commit without its files being touched; FTP and FTPS work this way. Tau uses your SSH config and agent, and reads passwords the way the VS Code extension saved them, once you allow each keychain item.
- **Changes on the server.** Tau checks when the project opens, when you click Check, and before a new thread's first prompt. What a colleague changed there comes in as a commit on `server-drift/<date>`; it is merged only when you click Merge.
- **Upload.** The server view (the server chip in the title bar) lists what differs from the server. Upload shows first what would go up, reads each file on the server again, and never overwrites a change made there unless you say so. Local deletions are listed as their own group. The agent can only propose an upload, as a card with a button.
- **Roll back.** Every upload is a deployment in the History tab, with the server's files as they were before. Roll back puts them back and is itself a deployment. Once your Git commit holds what went up, the deployment is marked committed.
- **The agent.** It reads the server freely (`server_read`, `server_list`, `server_diff`). Commands on the server (`server_exec`, SSH only) ask first unless you set the server to Full access in Settings → Servers; Git writes on the server are always refused. In a server project the agent's own commands reach only this machine and the package registries, until you allow more there.
- **On the phone.** The Servers sheet shows the status, and on a device with Full access it uploads and rolls back with the same preview first.

## Known limits

The network limit holds for Pi, the Agent SDK runtime and Codex (without any network for Codex); OpenCode, Antigravity, Cursor and Grok refuse to run there, and Windows has no limit at all ([Writing a package](EXTENSIONS.md#what-a-projects-commands-may-reach-servicesexecutionpolicy-new-in-api-1140)). Tau's own tools and your terminal are not limited. Spotting Git writes and local `ssh` to a server is a heuristic, not a wall. Many FTP servers list times to the minute, so a change of the same size within that minute is only found by a thorough check. See [ADR 0028](adr/0028-servers-as-a-work-target.md).
