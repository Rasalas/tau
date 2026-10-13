# Get started

Tau runs on macOS, Windows and Linux. Your phone pairs with it later.

## Install

Pick the installer for your system on the [download list](../../site/index.html#download).

- **Mac:** open the `.dmg` and drag Tau into Applications. There is a build for Apple silicon and one for Intel. Both are signed and notarized by Apple.
- **Windows:** run the installer. It installs Tau for your user. The installer isn't signed yet, so SmartScreen may warn: choose More info, then Run anyway.
- **Debian and Ubuntu:** open the `.deb` in your software center, or run `sudo apt install ./Tau-linux-amd64.deb`. It adds Tau to the application menu and `tau` to the command line.
- **Other Linux distributions:** make the `.AppImage` executable and start it. It needs FUSE 2 (`libfuse2`).

If your system asks whether to open an app you downloaded from the internet, confirm once. From then on Tau updates itself; [Updates and machines](updates-and-machines.md) explains how.

## First start

A Tau without threads opens its welcome wizard. It has three steps:

1. **Agents.** Which agent tools are installed and signed in, with the command to install or sign in to each one that isn't. Codex signs in right there with Continue with ChatGPT, and Tau fetches Codex itself.
2. **Projects.** The folders your agents worked in lately, newest first. Tick the ones you want in Tau.
3. **Conversations.** Earlier conversations from those tools, imported as threads you can continue.

A step with nothing to choose, such as projects on a machine whose agents have no history, is skipped. The wizard ends on a screen that names the agents that are ready and starts your first thread. Esc leaves it at any point; if no agent is ready yet, the wizard comes back on the next start. Type `/welcome` in the composer to open it again later.

Without a thread and without a repository open, Tau asks for a project instead of a draft. A project is any folder; **Start without a project** gives the thread a private folder of its own.

## Connect your agents

Tau uses the tools and sign-ins you already have. It never copies a login from one tool to another. Settings → Runtimes lists every runtime with its version; Settings → Providers has a card for each with its sign-in.

- **Claude Code:** install Anthropic's Claude Code and sign in there. Tau drives it for Anthropic's models, on your Claude plan. Don't sign Pi in with a Claude subscription: Anthropic sells it for Claude Code only.
- **Codex:** open Settings → Providers → Codex and choose Continue with ChatGPT. Tau manages the Codex download and connects your plan. You can also use an installed CLI and `codex login`.
- **Gemini:** Settings → Providers → Antigravity → **Install** downloads Google's Antigravity runtime. Sign in with your Google account on the same card.
- **Pi:** built in. Add API keys or sign-ins for OpenAI, Google, OpenCode Go and other providers under Settings → Providers.
- **OpenCode, Cursor and Grok:** install their command-line tools. Tau finds them on the `PATH` of your login shell.

## Your first thread

1. Press <kbd>⌘</kbd><kbd>N</kbd> (<kbd>Ctrl</kbd><kbd>N</kbd> on Windows and Linux), or the **+** above the thread list, and pick a project.
2. Under the new thread's heading, choose where it runs and on which branch. A branch of its own gets a Git worktree of its own, so the thread doesn't touch your checkout.
3. Type what you want done and send. The thread starts on the first runtime that is signed in, unless you pick one: the runtime and model are chips in the composer. A runtime that is signed out says so over the composer, with a button to its card in Settings → Providers.
4. Open **Terminal** or **Files** at the top right of the thread to watch the work.
5. When the thread is done, its branch waits in **Reviews** at the foot of the sidebar. Merge it, or send it back with a note.

## Your phone

1. On the machine that runs Tau, open Settings → Connections. Turn on **Local network**, or **Tailscale** to reach Tau from anywhere, and create a pairing link.
2. Scan its QR code with the Tau app, or with the phone's camera to open Tau in the browser.
3. That machine shows six digits and asks whether to let the phone in. Allow it if the phone shows the same six.

The phone then shows the same threads, their questions and your reviews. It talks to your machine directly; there is no Tau server in between.

## Next

- [Make a change](make-a-change.md): your own kit, or a change to Tau itself.
- [Updates and machines](updates-and-machines.md): how Tau stays current, and how another machine joins in.
- [Install and run](../install.md): every installer, Linux details, and the `tau` command.
- [Runtimes and tools](../runtimes.md): what each agent runtime needs, and pull request tools.
