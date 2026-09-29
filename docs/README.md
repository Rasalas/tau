# Tau's documents

The guides and the main reference pages are also on the website: <https://rasalas.github.io/tau/docs/>.

## Guides

- [Get started](site/get-started.md): install Tau, connect your agents, start a thread, pair your phone.
- [Install and run](install.md): every installer, Linux details, updates, the `tau` command, the first start, and running from a checkout.
- [Make a change](site/make-a-change.md): write a kit of your own, or change Tau and open a pull request.
- [Updates and machines](site/updates-and-machines.md): how Tau updates itself, other computers, and a host without a window.
- [Servers as a work target](servers.md): work on a site that lives on a server, upload and roll back.

## Reference

- [Runtimes and tools](runtimes.md): Claude Code, Codex, Antigravity and Pi, pull request tools, and a live Pi session.
- [Hosts, machines and devices](hosts.md): the host as a service, over a socket and TLS, other machines, the web client and the mobile app.
- [Architecture](architecture.md): core and kits, the window and the host, the extension seam.
- [Writing a package](EXTENSIONS.md): the manifest, permissions, isolation, signing, and the install, approve and reload workflow.
- [Core and kits](CORE.md): what the core owns, and what each shipped kit does.
- [Host updates](host-updates.md): the update design, the Linux helper and the threat model.
- [Host protocol](host-protocol.md): the versioned protocol between a client and the host.
- [Keybindings](keybindings.md), [project file](project-file.md), [agent definitions](agent-definitions.md), [browser cookie import](browser-cookie-import.md).
- [Windows](windows.md): what works on Windows, what is only tested, and how to try it.
- [Performance](PERFORMANCE.md): performance budgets, how they are measured, and the optimization plan.
- [Release](RELEASE.md): how a release is cut, how updates reach users, and how signing is enabled.
- [Mobile TestFlight](mobile-testflight.md) and the [mobile device checklist](mobile-device-checklist.md).

## The project

- [What Tau does](features.md): the workbench's features, in one list.
- [Roadmap and known limitations](roadmap.md): what is not done yet, and what Tau does not try to be.
- [VISION.md](VISION.md) explains the product goal and guiding principles.
- [CONTEXT.md](../CONTEXT.md) defines the product language used in code and discussions.
- [PLAN.md](PLAN.md) records the phased roadmap and open decisions.
- [CONTRIBUTING.md](../CONTRIBUTING.md) and [SECURITY.md](../SECURITY.md).

## Decisions

Every architecture decision is an ADR in [adr/](adr/). Among them:

- [ADR 0001](adr/0001-embed-pi-behind-a-desktop-host.md) records why Pi runs behind a desktop host.
- [ADR 0002](adr/0002-core-owns-placement-extensions-own-features.md) records why core owns placement while extensions own features.
- [ADR 0003](adr/0003-core-owns-threads-extensions-own-navigation.md) records why thread semantics stay in core while navigation remains replaceable.
- [ADR 0004](adr/0004-one-pi-runtime-per-thread.md) records why every open thread keeps its own Pi runtime.
- [ADR 0011](adr/0011-extension-distribution.md) records why packages are distributed through npm and Git instead of a registry of Tau's own.
- [ADR 0012](adr/0012-preview-browser.md) records why the preview is a host-owned browser view drawn over the panel.

## Notes and research, not kept current

- [opencode-diff-viewer-lessons.md](opencode-diff-viewer-lessons.md) inspects OpenCode's two diff-review layouts.
- [research/pi-remote-session.md](research/pi-remote-session.md) decides whether Tau should attach to Pi through Pi's own client instead of the session bridge.
- [research/model-provider-icons.md](research/model-provider-icons.md) recommends a source for model-provider icons.
