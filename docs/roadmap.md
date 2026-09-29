# Roadmap and known limitations

Tau is in alpha. The first builds proved the seams Tau was built to test: dynamic package loading, the extension
permission and isolation model, a host reached over a socket, a browser client of that host, and the
core/kit split into two artifacts. [PLAN.md](PLAN.md) records the completion check for each and the phased roadmap.

## Not done yet

- **A week of real use.** Phase 1's own completion check (working across several projects without
  reaching for the Pi TUI for a missing interaction) has not been run.
- **Windows, run for real.** The host has a Windows path for everything it found POSIX-only (see
  [Windows](install.md#windows)), but it is verified by tests on macOS and by a manual Windows workflow, not
  by a person using it on Windows.
- **One window showing two machines at once.** A window shows one machine's workbench at a time and
  loads again to show another ([ADR 0025](adr/0025-a-window-follows-the-threads-machine.md)).
- **`kits/` in a repository of its own.** Two artifacts from one repository first; splitting them
  is a governance decision with a second release train behind it and no forcing need yet.

Limits of single features are listed where the feature is described, for example [Servers](servers.md#known-limits) and [Windows](windows.md).

## Not goals

A full code editor, a replacement for Git tooling, feature-for-feature parity with
another workbench, or a new agent runtime. Those arrive through extensions when they improve agent work enough to
justify their maintenance cost.
