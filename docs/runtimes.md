# Runtimes and tools

Tau drives agents it does not ship: Pi, built in, and the command-line tools of Anthropic, OpenAI, Google and others. It uses them the way you set them up, with your sign-ins. [Get started](site/get-started.md#connect-your-agents) has the short version.

## What Tau takes from your machine

Tau uses your existing `~/.pi/agent` models, credentials, skills and extensions, and the tools of your machine. A model behind a subscription login Pi performs is marked in the picker; where the vendor allows that login only in its own apps (Anthropic, Google), the Subscription Login Warning kit asks once before its first use.

At startup the main process reads your login shell's environment (PATH, SSH agent, locale, Homebrew variables), so `git`, `claude`, editors and everything Pi's tools call resolve the way they do in a terminal, also after a Dock launch.

## Claude Code

Claude Code threads drive the installed `claude` CLI through the Claude Agent SDK, with its own login (a Claude subscription's Agent SDK credit, or an API key) and `~/.claude` settings; a different executable is set on its card under Settings → Providers (or with `TAU_CLAUDE_CODE_COMMAND`, which wins).

## Antigravity

Antigravity threads drive Google's Antigravity agent through the Agent Client Protocol: Tau downloads Google's ACP server once into its own state folder (from the official registry URL, verified by size and SHA-256) or uses a server of your own named on its Providers card (or by `TAU_ANTIGRAVITY_ACP_COMMAND`), and the sign-in with your Google account happens inside that server, in your browser; Tau never sees the token. Its card under Settings → Providers installs or updates that server, shows the account and signs out. The agent runs with a Gemini home of Tau's own, so it writes nothing into yours, but your `~/.gemini` skills are linked into it and your MCP servers are passed to it.

## Codex

Codex threads drive the installed `codex` CLI through its app server (`codex app-server`), signed in the way the CLI is (`codex login` with your ChatGPT plan, or an API key) with your `~/.codex` (or `CODEX_HOME`) sessions and config; Tau reads no credential. A different executable is set on its card under Settings → Providers (or with `TAU_CODEX_COMMAND`). Codex's approval requests appear in the thread like any other question, and Tau's access levels become Codex's sandbox and approval policy.

## Keeping the CLIs current

For Claude Code and Codex, the picker's runtime tab and Settings → Runtimes say when npm has a newer release of the CLI than the one installed, with the command that updates it; for Antigravity, when Tau pins a newer server than it installed.

## Which runtime a thread gets

Which runtime a new thread gets is chosen in the composer before its first message, or in Settings → Runtimes; a thread keeps its runtime for life.

`TAU_RUNTIME_ADAPTER=pi` (default) keeps the embedded Pi runtime; `TAU_RUNTIME_ADAPTER=claude-code` or `antigravity` makes that backend, which the bundled `tau.claude-code` or `tau.antigravity` host extension registers, the default for new threads and the thread opened at startup (a name without a registered extension stops the start with an error dialog). The composer's runtime chip and Settings → Runtimes override the default per client.

## Pull and merge requests

When `gh` or `glab` is installed and logged in, the Review's branch scope diffs against the base branch of the current branch's pull or merge request and links to it; the Changes panel then commits, pushes and opens that request (title and description written by the commit-message model, filled into the repository's template, optionally as a draft), edits and merges it, and the thread's rail row shows its state and checks. Without the CLI, its login or a remote, the panel says which one is missing.

Forgejo and Gitea (through `tea`, signed in with `tea login add`), Bitbucket Cloud (with an API token Git's credential helper holds for `api.bitbucket.org`) and Azure DevOps (through `az` with its DevOps extension) open, edit, merge and review requests the same way, as far as each host's tools reach; what one cannot do is hidden rather than offered. Settings → Review lists which of them this machine can reach and lets you name the provider of a self-hosted server whose host name does not say.

## Share a live session with Pi

Tau can attach to a Pi TUI that already owns the active session instead of opening a second `SessionManager`. Open Pi in the project first. For an already-running Pi session, run `/reload` once so Pi loads `.pi/extensions/tau-session-bridge.ts`, then start or restart Tau. Prompts, steering, aborts, assistant streaming, tool activity, model changes, thinking changes, compaction, and thread renames travel over an authenticated local socket and remain visible in both clients.

The Pi TUI is the sole writer while attached. Tau will not fall back to writing the same session if the owner is alive but unreachable. It retries a lost socket with bounded backoff and resnapshots automatically after Pi reloads or restarts the bridge. Image prompts, Tau project-shell actions, Tau access-policy changes, new-session creation, and automatic title generation remain Pi-side operations in this mode. Safe mode refuses to attach because it cannot enforce safe-mode tool policy on a runtime owned by another process.

A Pi you start in Tau's own terminal holds the session lock instead: [The window and the host](architecture.md#the-window-and-the-host) explains it.

## Apply changes with `/reload`

Enter `/reload` in Tau, or run "Apply changes and reload Tau" from the command palette. Tau builds its source first and then picks the shortest way to apply it: a change to kits or to the renderer reloads those and the window while every thread keeps running, so a turn in flight never notices it; a change to a kit's runtime half (`pi.cjs`) reloads Pi's resources too, and that is the only path that still offers to wait for or stop running threads; a change to the Electron main process or preload restarts Tau.
