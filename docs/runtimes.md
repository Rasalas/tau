# Runtimes and tools

Tau runs Pi, built in, and the command-line tools of Anthropic, OpenAI, Google and others. Tau can manage a pinned Codex installation for ChatGPT plan connections. It uses them the way you set them up, with your sign-ins. [Get started](site/get-started.md#connect-your-agents) has the short version.

## What Tau takes from your machine

Tau uses your existing `~/.pi/agent` models, credentials, skills and extensions, and the tools of your machine. A model behind a subscription login Pi performs is marked in the picker; where the vendor allows that login only in its own apps (Anthropic, Google), the Subscription Login Warning kit asks once before its first use.

At startup the main process reads your login shell's environment (PATH, SSH agent, locale, Homebrew variables), so `git`, `claude`, editors and everything Pi's tools call resolve the way they do in a terminal, also after a Dock launch.

On Linux with a systemd user manager, each CLI the host starts (and every terminal and Pi bash call) runs in its own scope with a memory ceiling, so an out-of-memory kill takes that agent and the thread says "Killed: out of memory." instead of the host going down with it. Pi itself runs inside the host process and gets no scope of its own. [What is covered](CORE.md#memory-pressure-on-linux), [how to check it](hosts.md#agents-under-memory-pressure-on-linux).

## Model display names

Under Settings → Runtimes → a runtime → Models, edit a model's display name and
press Enter or leave the field to save it. Escape discards an edit. Leave the
field blank to restore the runtime's name. Applies to chooses the machine or
project as it does for the model list's order and hidden models.

The composer, model picker and model palette use that name for this runtime.
Search also finds the original name and model ID. `/model <query>` accepts a
custom name too; catalog names and IDs take precedence when names collide. Display names leave model
selection, capabilities, billing and the model sent to the runtime unchanged.

## Claude Code

Claude Code threads drive the installed `claude` CLI through the Claude Agent SDK, with its own login (a Claude subscription's Agent SDK credit, or an API key) and `~/.claude` settings; a different executable is set on its card under Settings → Runtimes (or with `TAU_CLAUDE_CODE_COMMAND`, which wins).

## Antigravity

Antigravity threads drive Google's Antigravity agent through the Agent Client Protocol: Tau downloads Google's ACP server once into its own state folder (from the official registry URL, verified by size and SHA-256) or uses a server of your own named on its Providers card (or by `TAU_ANTIGRAVITY_ACP_COMMAND`), and the sign-in with your Google account happens inside that server, in your browser; Tau never sees the token. Its card under Settings → Runtimes installs or updates that server, shows the account and signs out. The agent runs with a Gemini home of Tau's own, so it writes nothing into yours, but your `~/.gemini` skills are linked into it and your MCP servers are passed to it. For the same reason Onboarding cannot import your own Antigravity conversations; the wizard says so when it finds them. Antigravity has no read-only mode: it asks instead, so an MCP client whose execution ceiling is read-only cannot start Antigravity threads.

## Codex

Codex threads drive `codex app-server`. Under **Settings → Runtimes → Codex**, choose **Continue with ChatGPT** to authorize Tau to use your ChatGPT plan. Tau downloads a pinned Codex release when needed, verifies its archive, and keeps it in its own host state. You do not need to install the CLI first. When a Tau update pins a newer release, Tau fetches it by itself when it starts and removes the old one; the card and the composer show the progress, and a thread opened meanwhile starts once it is ready. If the download fails or its files need repair, use **Try again** or **Install managed Codex** on that account’s card. An instance with no `codex` of its own on the PATH also runs this managed release once Tau has it. An explicit executable override must support this connection. The existing CLI browser, device-code, API-key and terminal logins remain available for instances using the CLI’s own account and `~/.codex` or `CODEX_HOME`. A different executable is set on its card under Settings → Runtimes (or with `TAU_CODEX_COMMAND`). Codex's approval requests appear in the thread like any other question, and Tau's access levels become Codex's sandbox and approval policy.

The first successful plan connection shows a usage confirmation. The composer shows **Using ChatGPT plan** and the active account. **Manage usage** opens [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage), including after a plan-limit error. ChatGPT usage is shared with other apps and follows the limits and credit settings you authorize there.

Each Codex instance keeps one account registration and its own protected credentials. Sessions stay independent by default; compatible instances may share their canonical session home. Use **Add instance** for another ChatGPT account or workspace, even if its email address is the same. A thread keeps the runtime backend owner it started on. Compatible CLI accounts can change which account executes its next turn. An instance that already has CLI threads cannot be converted to the Tau-managed plan connection; add an instance so those conversations keep their original sessions.

The browser normally completes sign-in through a loopback callback on the Tau host. If the browser is on another machine, copy its final `http://127.0.0.1:…/auth/callback?…` URL into the sign-in prompt. Tau validates that attempt's URI and state before exchanging the code. Do not share the callback URL with others.

For CLI accounts sharing one session home, set the same `CODEX_HOME` in each instance and set `TAU_CODEX_AUTH_HOME` to a distinct fresh folder in each account instance's environment. Tau links shared sessions and runtime data into those auth homes, keeps `auth.json` and model caches private, and uses file credential storage for overlays. Sign in on each instance's Providers card. In an existing thread, open the composer's menu and select the account under **Codex account**. Incompatible accounts show the reason they cannot be selected. Changing an account waits until the thread is idle and resumes the same Codex session; a failure leaves the original account selected. Managed ChatGPT accounts can also switch when both instances explicitly configure the same home before starting their threads. Tau retains a private effective home and OAuth registration for each account while sharing local rollouts. It restarts Codex with the selected account's token and resumes the same local conversation. Independent managed homes and mixed CLI/managed connections show an incompatibility reason. A successful local resume does not establish entitlement to the selected model; the next inference request verifies access. Changing an instance's shared home after a conversation has started refuses continuation until you restore its original configuration.

Fast, Codex's `fast` tier (or the first tier that calls itself fast, such as Ultrafast), is the thinking chip's Speed choice (K142, `registerComposerSpeed`); the composer menu offers **Codex service tier** for any other tier the CLI's model catalog reports. Names and descriptions come from Codex, including Ultrafast where the account and model offer it. **Provider default** leaves tier selection to Codex; **Standard** requests the standard tier; selecting a tier persists it for this thread and sends it to Codex. Changing models or accounts clears the explicit selection. Managed ChatGPT connections hide tiers because that provider does not advertise this control. Tau accepts future ChatGPT plan names and tier IDs without rejecting the whole account catalog. Codex fetches that catalog as the client that started it, and every Codex client on the machine shares the cache, so Tau starts each app-server as `tau` (`CODEX_INTERNAL_ORIGINATOR_OVERRIDE`, a value you set wins) and, for a ChatGPT account, waits up to three seconds for a refreshed catalog before it lists the models; otherwise a tier such as Ultrafast can be missing from the picker.

Tau stores one stable host ID, issued account registrations, and credential files under the Codex kit’s host state, stored on this machine and readable only by your user account, the way Codex keeps its own `auth.json`. They are not encrypted with the system keychain: the Tau host also runs as a background service without Electron, where no keychain is available. Access, refresh and identity tokens never enter browser storage or logs, and the commands Codex runs never see the access token. Tau refreshes rotating credentials under a process lock, then restarts Codex between turns and resumes the same stored conversation. A turn that expires while running may fail; Tau does not replay it automatically. Sign out stops local Codex sessions, attempts remote refresh-token revocation, and clears local tokens. If revocation cannot be confirmed, Tau tells you to disconnect it in ChatGPT Settings. The account registration and host ID remain for a later sign-in.

This connection uses the public Responses API and the account’s current model catalog. Local shell and MCP tools work. Hosted connectors, image generation and Responses `tool_search` are not supported by this route. Pi does not use this connection yet. See OpenAI’s [open-source sign-in documentation](https://developers.openai.com/siwc/token-sharing-open-source) and [current limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## OpenCode

OpenCode threads drive `opencode serve` over HTTP: Tau starts one server per live thread on 127.0.0.1 with a password of its own, or connects to a server you run (a URL and a password on its card under Settings → Runtimes). The providers and logins are OpenCode's own; Tau reads no credential. A different executable is set on the card (or with `TAU_OPENCODE_COMMAND`), and another instance can take a home of its own (`TAU_OPENCODE_HOME` becomes OpenCode's four XDG folders).

Tau speaks both server APIs: OpenCode 1 (from 1.14.19, tested with 1.18.32) and OpenCode 2 (`@opencode/cli`, from 2.0.10, run against 2.0.26). The server tells which it is, so one card serves either; a thread keeps the server it started on. The card flags a release it did not run (2.0.10 to 2.0.25, or a newer major) and refuses ones that lack routes it needs (OpenCode 2 before 2.0.10, OpenCode 1 before 1.14.19), with the install command for the tested release of the line you have. A newer 2.x release is accepted without a warning.

What works on both: sessions resumed by id, streamed text, reasoning and tool cards, stop, steering a running turn, the plan mode as OpenCode's plan agent, Tau's access levels as the session's permission rules, permission requests and questions in the thread (also those of OpenCode's sub-agents), the models of every connected provider with price and reasoning variants, Tau's own MCP tools, and Onboarding's import of OpenCode's sessions. OpenCode 2 differences you can see: "Allow for this session" grants the rule to that session only (OpenCode 2 would keep an "always" for the project), and a declined command or dismissed question lets the model go on instead of ending the run. Usage also reads OpenCode 2's database (`opencode.db`, read-only), so work done outside Tau with it is counted once; a database whose layout changed is skipped with the reason shown in Usage.

## Images sent with a prompt

Each image goes to a vision model as image input and is also saved as a file in the thread's `prompt-images` folder on its home machine, so the agent can attach it to a pull request or process it. Codex, OpenCode and ACP runtimes receive that file as an attachment; Claude Code gets its path in an `Attached files:` block and Pi in a hidden context note. The folder is removed when the thread is purged.

## Importing conversations

Onboarding imports the sessions of Claude Code, Codex and OpenCode, and those of Cursor and Grok when the CLI lists them over ACP (`session/list`) and can replay them (`session/load`). Otherwise the wizard says why they can't be imported.

## Custom models for ACP runtimes

Open **Settings → Runtimes**, choose Cursor, Grok or Antigravity, and enter
one model ID per line in **Custom models**. The field saves when you leave it
or press ⌘Return on macOS, Ctrl+Return elsewhere. Empty lines and repeated
IDs are ignored. Each list applies to every instance of that runtime on
this machine.

After saving, choose **Refresh models** in the model picker. The refreshed
catalog and sessions started after saving use the new list without restarting
Tau. Existing sessions keep the model list they read at startup; start a new
thread to use an added ID there.

The picker uses the ID as the model's name. Only explicitly listed IDs bypass
the local model check; the agent decides whether it can run them, and its
error is shown if it refuses. Modes and reasoning options still accept only
the agent's advertised choices.

Alternatively, set the same values in this machine's `~/.tau/config.json`,
using `\n` between IDs in each string:

```json
{
  "values": {
    "tau.cursor.customModels": "gateway/new-model",
    "tau.grok.customModels": "gateway/new-model",
    "tau.antigravity.customModels": "gateway/new-model"
  }
}
```

## Keeping the CLIs current

Settings → Runtimes lists, under **Agent tools**, each agent CLI Tau drives: its version, where it comes from and the command that updates it. Tau reads the source from where the executable really lives: a Homebrew formula or cask (only the formulae and casks each runtime names, and only with the `brew` of that prefix), a global npm, pnpm or bun install (the package's own folder in the path, so a global under a Homebrew-installed Node counts as npm's), or the program's own installer (the Agent SDK runtime's CLI under `~/.local/share`, `cursor-agent`, OpenCode's install script). Anything else, Grok Build's CLI among it for now, is shown as unknown and left to you.

With **Keep agent tools up to date** on (Tau asks once, when the first update is out; the choice holds for this machine), Tau checks every six hours and runs that update itself as soon as none of the runtime's turns runs, then asks the program for its version and models again. Each run lands in the page's activity log with its command; a failed one keeps its output and the version it left. **Update now** runs one update by hand. Without the setting, the picker's runtime tab and an update toast say when a newer release is out, as before; for Antigravity, when Tau pins a newer server than it installed.

A Homebrew cask can lag npm by a release (Codex 0.159.1 was on npm while the cask still had 0.159.0). The page then says so ("Homebrew has 0.159.0, npm 0.159.1") and offers **Switch to npm**: after you confirm, Tau removes the Homebrew install and installs the npm package; if npm fails, it puts the Homebrew install back. Tau never switches on its own. Every command is an argument list built from the package names Tau knows, never a shell line. A test instance (`TAU_RUNTIME_UPDATE_COMMAND` or `TAU_NO_RUNTIME_UPDATES=1`) and safe mode run none.

The Codex that Tau manages for ChatGPT plan connections is not part of this: it is no install of yours, Tau pins its release, and it changes only with a Tau update, which fetches the new release by itself.

A model list follows its program: once a CLI was replaced (its file's path, size or time changed), the next picker asks it again instead of showing what the old one named. **Refresh** on the Agent tools section asks every runtime at once.

## Models Pi does not know yet

Pi's model list comes with Tau's Pi package and with Pi's own online catalog. Tau adds a catalog of its own on top: `https://rasalas.github.io/tau/catalog/models.json`, signed with Tau's release key (`models.json.sig`). A host fetches it once a day (and on Refresh), checks the signature against the keys it ships and ignores a file without a valid one or with a lower `revision`; offline it keeps the last good copy (`<userData>/model-catalog.json`). The catalog only adds models Pi does not list, each built on a model of the same provider (`like`), with its context, output, input kinds, thinking levels, price per million tokens and release date; a provider your own `~/.pi/agent/models.json` shapes is left alone. `TAU_NO_MODEL_CATALOG=1` or `PI_OFFLINE` keeps it off the network.

To change it, edit `catalog/models.json` (one entry per provider and model; raise `revision` with every change, never lower it) and merge to main: the Pages workflow builds it (`npm run site:catalog`), signs it with `TAU_RELEASE_SIGNING_KEY` in the `release` environment and publishes it with the site. Nothing is signed on a laptop. A test host reads its own catalog with `TAU_MODEL_CATALOG_URL` (an `https:` or `file:` address) and `TAU_MODEL_CATALOG_KEY`, the throwaway key that signed it.

## Which runtime a thread gets

Which runtime a new thread gets is chosen in the composer before its first message, or in Settings → Runtimes; a thread keeps its runtime for life.

`TAU_RUNTIME_ADAPTER=pi` (default) keeps the embedded Pi runtime; `TAU_RUNTIME_ADAPTER=claude-code` or `antigravity` makes that backend, which the bundled `tau.claude-code` or `tau.antigravity` host extension registers, the default for new threads and the thread opened at startup (a name without a registered extension stops the start with an error dialog). The composer's runtime chip and Settings → Runtimes override the default per client.

While nothing was chosen and the host's default cannot start a thread (Pi with no model provider, or a runtime that is signed out or not installed), the window starts new threads on the first runtime that is ready, in the host's order, and sends that runtime with the first prompt. The window reads what is ready from the runtimes' catalogs (`runtime-catalogs`; the answers the host already holds are enough). A draft on a runtime whose catalog says it is signed out, not installed or has no model provider shows a bar over the composer with the way to its card under Settings → Runtimes; Send stays on, since a catalog can be older than a sign-in. When no runtime the project offers can start a thread, the bar says "No provider is set up yet" and Send stays off until one can. A runtime chosen on purpose is never replaced.

## Turning a runtime off for a project

Settings → Runtimes has a switch in each runtime's list entry and in its head, for Pi, the Agent SDK runtime, Codex, OpenCode, Cursor, Grok, Antigravity and every instance such as `codex@work`. Choose "Applies to" at the top of the page first: with This machine selected the switch turns the runtime off or on everywhere, with a project selected it overrides this machine for that project only, in either direction (off in one repository, or on in one while the machine has it off). The layers icon beside the switch shows where the value comes from, and the undo arrow returns the project to the machine's setting. The same choice is written to `runtimeEnabled` in `~/.tau/config.json` or `<project>/.tau/config.json`, so a repository can keep a runtime out for everyone who opens it.

Turning a runtime off does not remove it: its entry, sign-in and models stay, and threads it already has stay readable. What stops is starting work on it in that project. The runtime chip, the model picker, the palette and "Continue in" stop offering it, and the app refuses everything that would start or wake a turn there with "Codex is turned off for “app”. Turn it on under Settings → Runtimes, with Applies to set to the project.": a new thread, a message, a steer, a follow-up, a queued message, an agent's `tau_spawn_thread` and a scheduled run (which shows as failed with that line), a fork, and the continuation of a thread after a restart (the thread is marked as interrupted instead). A turn that is already running finishes. A thread in a worktree follows the project the worktree was made from.

Tau also stops checking a runtime's program for updates once no project uses it: a runtime is in use while the machine or any project you opened keeps it on. Refresh and Update on Settings → Runtimes still work.

## Pull and merge requests

When `gh` or `glab` is installed and logged in, the Review's branch scope diffs against the base branch of the current branch's pull or merge request and links to it. With files changed, the project card's Git button reads "Commit, push & PR": one card shows the files, a commit message and a title and description a model has written (filled into the repository's template, optionally as a draft), both editable, and commits, pushes and opens the request on one press, naming the step that failed so the next press continues there. Once the work is committed the button reads "Create PR" and opens the same texts as a form that writes itself when it is empty; the Changes panel edits and merges it, and the thread's rail row shows its state and checks. Without the CLI, its login or a remote, the panel says which one is missing.

Forgejo and Gitea (through `tea`, signed in with `tea login add`), Bitbucket Cloud (with an API token Git's credential helper holds for `api.bitbucket.org`) and Azure DevOps (through `az` with its DevOps extension) open, edit, merge and review requests the same way, as far as each host's tools reach; what one cannot do is hidden rather than offered. Settings → Source control lists which of them this machine can reach and lets you name the provider of a self-hosted server whose host name does not say.

## Share a live session with Pi

Tau can attach to a Pi TUI that already owns the active session instead of opening a second `SessionManager`. Open Pi in the project first. For an already-running Pi session, run `/reload` once so Pi loads `.pi/extensions/tau-session-bridge.ts`, then start or restart Tau. Prompts, steering, aborts, assistant streaming, tool activity, model changes, thinking changes, compaction, and thread renames travel over an authenticated local socket and remain visible in both clients.

The Pi TUI is the sole writer while attached. Tau will not fall back to writing the same session if the owner is alive but unreachable. It retries a lost socket with bounded backoff and resnapshots automatically after Pi reloads or restarts the bridge. Image prompts, Tau project-shell actions, Tau access-policy changes, new-session creation, and automatic title generation remain Pi-side operations in this mode. Safe mode refuses to attach because it cannot enforce safe-mode tool policy on a runtime owned by another process.

A Pi you start in Tau's own terminal holds the session lock instead: [The window and the host](architecture.md#the-window-and-the-host) explains it.

## Apply changes with `/reload`

Enter `/reload` in Tau, or run "Apply changes and reload Tau" from the command palette. Tau builds its source first and then picks the shortest way to apply it: a change to kits or to the renderer reloads those and the window while every thread keeps running, so a turn in flight never notices it; a change to a kit's runtime half (`pi.cjs`) reloads Pi's resources too, and that is the only path that still offers to wait for or stop running threads; a change to the Electron main process or preload restarts Tau.

## Muse Code and other ACP agents

Settings → ACP agents includes Muse Code and lets you add an installed ACP command
or select an agent from the official ACP registry. Install Muse Code and run
`muse login` first. Its native ACP command is experimental; Tau enables
`MUSE_EXPERIMENTAL_ACP=on` for that entry. Muse's current ACP limitations are
listed in its [editor integration documentation](https://meta-models.github.io/muse-code-sdk/next/guides/editors-acp/).

Each custom entry has a stable ID, executable, literal argument array, optional
environment and authentication method. Use a separate ID for another account.
Once an entry has threads, its launch configuration is locked; create another
entry to change it. Agent processes inherit the host environment with the entry's
overrides. Tau does not parse shell expressions in commands or arguments.

Registry package versions stay pinned to their selected entry. npx or uvx fetches
package agents when first used. Binary distributions download into Tau's own
private state and require the advertised SHA-256. The registry does not install
anything until you select Add agent. An unavailable registry leaves manual
configuration usable. Agent authentication and available models remain the
agent's own. A generic ACP agent without an advertised read-only mode cannot run
at Tau's read-only access level.

## Switch runtime in a conversation

Choose **Switch runtime** above the composer, then a runtime under **Switch runtime
in this conversation**. The conversation retains its ID, workspace and stage. Its
visible history stays above replies from the new runtime. The next prompt gives
that runtime the preceding conversational text. Provider-private state and old
image pixels do not transfer. The original runtime session remains available for
a later switch back.

Finish the active turn, queued messages and native background work first. End a
native goal before switching. Very long conversations use the existing Continue
in handoff to a new summarized thread instead.

## Diagnose a local installation

Run `tau triage --agent codex` or `tau triage --agent claude` even if Tau cannot
start. The command saves a private report with system information and bounded,
redacted log tails, then opens that agent to investigate. `tau triage --print`
only creates the report. Reports stay under this instance's diagnostics folder;
publication of an issue is a separate user action.
