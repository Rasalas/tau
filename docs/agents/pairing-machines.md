# Pairing two machines as an agent

Use this when you can reach another machine with `ssh <target>` and want Tau on this computer to use it (open its threads, run sub-agents there).

```bash
tau machines add --ssh <target> --agents --json   # pairs; again: only checks
tau machines list --json                          # { window, machines: [{ id, name, window?, agents? }] }
tau machines remove <name or id>
```

- Tau has to run on both machines (window or `tau service`). The other machine needs a Tau with `tau machines` and network access turned on (Settings → Connections → Network access). Otherwise the command says so and does nothing.
- ssh runs with `BatchMode=yes`: it never prompts. If the key or host key is not set up, the command fails with ssh's reason. Do not work around that; ask the user.
- Nothing secret goes on a command line, into the environment or into a file. The link lives two minutes and travels over the SSH session only. Do not copy, print or log it yourself.
- `--agents` is what lets this computer's agents work there. Without a running window only the agents keep the machine, so pass `--agents` then.
- Exit code 0 means paired and connected. 1 means an error (message on stderr), or paired but not connected yet (see `list`).
- Never run this against a real machine in a test. Tests use two test hosts and the fake SSH server: `npm run smoke:ssh-pairing` (docs/agents/testing-the-app.md).
