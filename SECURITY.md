# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on this repository
(<https://github.com/Rasalas/tau/security/advisories/new>).
Please do not open a public issue for a security problem.

Include what you found, how to reproduce it, the Tau version (Settings → About)
and your operating system. You will get an answer within a week. A fix ships in
a patch release, and the advisory is published with it.

## Supported versions

Only the latest release gets security fixes. Tau updates itself; the
[releases page](https://github.com/Rasalas/tau/releases) has the current build.

## Scope

In scope:

- the desktop app, its host process, the web and mobile clients;
- pairing, client tokens and the host's network listeners;
- the kits in `kits/` and the extension permission and isolation model;
- the update path: release feeds, their signatures and the installers.

Out of scope: vulnerabilities in the agent runtimes and command-line tools Tau
starts (Pi, Codex, the Agent SDK runtime and others) unless Tau's own handling
makes them worse, and third-party extension packages that are not in this
repository.
