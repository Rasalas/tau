# Runtimes and tools

Tau runs Pi, built in, and the command-line tools of Anthropic, OpenAI, Google and others. Tau can manage a pinned Codex installation for ChatGPT plan connections. It uses them the way you set them up, with your sign-ins. [Get started](site/get-started.md#connect-your-agents) has the short version.

## What Tau takes from your machine

Tau uses your existing `~/.pi/agent` models, credentials, skills and extensions, and the tools of your machine. A model behind a subscription login Pi performs is marked in the picker; where the vendor allows that login only in its own apps (Anthropic, Google), the Subscription Login Warning kit asks once before its first use.

At startup the main process reads your login shell's environment (PATH, SSH agent, locale, Homebrew variables), so `git`, `claude`, editors and everything Pi's tools call resolve the way they do in a terminal, also after a Dock launch.

## Claude Code

Claude Code threads drive the installed `claude` CLI through the Claude Agent SDK, with its own login (a Claude subscription's Agent SDK credit, or an API key) and `~/.claude` settings; a different executable is set on its card under Settings → Providers (or with `TAU_CLAUDE_CODE_COMMAND`, which wins).

## Antigravity

Antigravity threads drive Google's Antigravity agent through the Agent Client Protocol: Tau downloads Google's ACP server once into its own state folder (from the official registry URL, verified by size and SHA-256) or uses a server of your own named on its Providers card (or by `TAU_ANTIGRAVITY_ACP_COMMAND`), and the sign-in with your Google account happens inside that server, in your browser; Tau never sees the token. Its card under Settings → Providers installs or updates that server, shows the account and signs out. The agent runs with a Gemini home of Tau's own, so it writes nothing into yours, but your `~/.gemini` skills are linked into it and your MCP servers are passed to it.

## Codex

Codex threads drive `codex app-server`. Under **Settings → Providers → Codex**, choose **Continue with ChatGPT** to authorize Tau to use your ChatGPT plan. Tau downloads a pinned Codex release when needed, verifies its archive, and keeps it in its own host state. You do not need to install the CLI first. If a Tau update needs a newer managed release or its files need repair, use **Install managed Codex** on that account’s card. An explicit executable override must support this connection. The existing CLI browser, device-code, API-key and terminal logins remain available for instances using the CLI’s own account and `~/.codex` or `CODEX_HOME`. A different executable is set on its card under Settings → Providers (or with `TAU_CODEX_COMMAND`). Codex's approval requests appear in the thread like any other question, and Tau's access levels become Codex's sandbox and approval policy.

The first successful plan connection shows a usage confirmation. The composer shows **Using ChatGPT plan** and the active account. **Manage usage** opens [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage), including after a plan-limit error. ChatGPT usage is shared with other apps and follows the limits and credit settings you authorize there.

Each Codex instance keeps one account registration and its own protected credentials. Sessions stay independent by default; compatible instances may share their canonical session home. Use **Add instance** for another ChatGPT account or workspace, even if its email address is the same. A thread keeps the runtime backend owner it started on. Compatible CLI accounts can change which account executes its next turn. An instance that already has CLI threads cannot be converted to the Tau-managed plan connection; add an instance so those conversations keep their original sessions.

The browser normally completes sign-in through a loopback callback on the Tau host. If the browser is on another computer, copy its final `http://127.0.0.1:…/auth/callback?…` URL into the sign-in prompt. Tau validates that attempt's URI and state before exchanging the code. Do not share the callback URL with others.

For CLI accounts sharing one session home, set the same `CODEX_HOME` in each instance and set `TAU_CODEX_AUTH_HOME` to a distinct fresh folder in each account instance's environment. Tau links shared sessions and runtime data into those auth homes, keeps `auth.json` and model caches private, and uses file credential storage for overlays. Sign in on each instance's Providers card. In an existing thread, open the composer's menu and select the account under **Codex account**. Incompatible accounts show the reason they cannot be selected. Changing an account waits until the thread is idle and resumes the same Codex session; a failure leaves the original account selected. Managed ChatGPT accounts can also switch when both instances explicitly configure the same home before starting their threads. Tau retains a private effective home and OAuth registration for each account while sharing local rollouts. It restarts Codex with the selected account's token and resumes the same local conversation. Independent managed homes and mixed CLI/managed connections show an incompatibility reason. A successful local resume does not establish entitlement to the selected model; the next inference request verifies access. Changing an instance's shared home after a conversation has started refuses continuation until you restore its original configuration.

The same composer menu offers **Codex service tier** when the CLI's model catalog reports tiers. Names and descriptions come from Codex, including Ultrafast where the account and model offer it. **Provider default** leaves tier selection to Codex; **Standard** requests the standard tier; selecting a tier persists it for this thread and sends it to Codex. Changing models or accounts clears the explicit selection. Managed ChatGPT connections hide tiers because that provider does not advertise this control. Tau accepts future ChatGPT plan names and tier IDs without rejecting the whole account catalog.

Tau stores one stable host ID, issued account registrations, and owner-only credential files under the Codex kit’s host state. Access, refresh and identity tokens never enter browser storage or logs. Tau refreshes rotating credentials under a process lock, then restarts Codex between turns and resumes the same stored conversation. A turn that expires while running may fail; Tau does not replay it automatically. Sign out stops local Codex sessions, attempts remote refresh-token revocation, and clears local tokens. If revocation cannot be confirmed, Tau tells you to disconnect it in ChatGPT Settings. The account registration and host ID remain for a later sign-in.

This connection uses the public Responses API and the account’s current model catalog. Local shell and MCP tools work. Hosted connectors, image generation and Responses `tool_search` are not supported by this route. Pi does not use this connection yet. See OpenAI’s [open-source sign-in documentation](https://developers.openai.com/siwc/token-sharing-open-source) and [current limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## Keeping the CLIs current

Settings → Runtimes lists, under **Agent tools**, each agent CLI Tau drives: its version, where it comes from and the command that updates it. Tau reads the source from where the executable really lives: a Homebrew formula or cask (only the formulae and casks each runtime names, and only with the `brew` of that prefix), a global npm, pnpm or bun install (the package's own folder in the path, so a global under a Homebrew-installed Node counts as npm's), or the program's own installer (the Agent SDK runtime's CLI under `~/.local/share`, `cursor-agent`, OpenCode's install script). Anything else, Grok Build's CLI among it for now, is shown as unknown and left to you.

With **Keep agent tools up to date** on (Tau asks once, when the first update is out; the choice holds for this machine), Tau checks every six hours and runs that update itself as soon as none of the runtime's turns runs, then asks the program for its version and models again. Each run lands in the page's activity log with its command; a failed one keeps its output and the version it left. **Update now** runs one update by hand. Without the setting, the picker's runtime tab and an update toast say when a newer release is out, as before; for Antigravity, when Tau pins a newer server than it installed.

A Homebrew cask can lag npm by a release (Codex 0.159.1 was on npm while the cask still had 0.159.0). The page then says so ("Homebrew has 0.159.0, npm 0.159.1") and offers **Switch to npm**: after you confirm, Tau removes the Homebrew install and installs the npm package; if npm fails, it puts the Homebrew install back. Tau never switches on its own. Every command is an argument list built from the package names Tau knows, never a shell line. A test instance (`TAU_RUNTIME_UPDATE_COMMAND` or `TAU_NO_RUNTIME_UPDATES=1`) and safe mode run none.

A model list follows its program: once a CLI was replaced (its file's path, size or time changed), the next picker asks it again instead of showing what the old one named. **Refresh** on the Agent tools section asks every runtime at once.

## Models Pi does not know yet

Pi's model list comes with Tau's Pi package and with Pi's own online catalog. Tau adds a catalog of its own on top: `https://rasalas.github.io/tau/catalog/models.json`, signed with Tau's release key (`models.json.sig`). A host fetches it once a day (and on Refresh), checks the signature against the keys it ships and ignores a file without a valid one or with a lower `revision`; offline it keeps the last good copy (`<userData>/model-catalog.json`). The catalog only adds models Pi does not list, each built on a model of the same provider (`like`), with its context, output, input kinds, thinking levels, price per million tokens and release date; a provider your own `~/.pi/agent/models.json` shapes is left alone. `TAU_NO_MODEL_CATALOG=1` or `PI_OFFLINE` keeps it off the network.

To change it, edit `catalog/models.json` (one entry per provider and model; raise `revision` with every change, never lower it) and merge to main: the Pages workflow builds it (`npm run site:catalog`), signs it with `TAU_RELEASE_SIGNING_KEY` in the `release` environment and publishes it with the site. Nothing is signed on a laptop. A test host reads its own catalog with `TAU_MODEL_CATALOG_URL` (an `https:` or `file:` address) and `TAU_MODEL_CATALOG_KEY`, the throwaway key that signed it.

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

## Banked usage resets

Usage shows banked reset counts for a Codex CLI ChatGPT account and for eligible Claude subscriptions. **Use reset** asks for confirmation, then redeems one reset on the machine that owns that account and refreshes its limits. A Read-only device cannot redeem a reset. Tau-managed ChatGPT plan connections continue to use **Manage usage** in ChatGPT Settings.

Codex selects its credit through `account/rateLimitResetCredit/consume`. Claude uses the next eligible, unpaused, unexpired grant selected by its CLI usage endpoint. Claude resets are unavailable on macOS because Claude keeps its login in Keychain. Tau does not read Keychain for this feature. Other hosts use the credentials already stored by Claude in that instance's configuration directory.

Overlapping requests on one host for the same account share one attempt. Tau retains its request ID in its own host state if the provider does not confirm the result, including across restart. **Check reset** retries that attempt instead of spending another reset. A confirmed reset can still leave the displayed limits stale if refreshing fails; refresh the Usage page to check. Authentication errors, cooldowns and provider rate limits are shown without credential data.

Protocol references: OpenAI's [generated reset parameters](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ConsumeAccountRateLimitResetCreditParams.ts), [reset outcomes](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ConsumeAccountRateLimitResetCreditOutcome.ts) and [usage response](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/GetAccountRateLimitsResponse.ts). Claude's banked reset endpoints are CLI compatibility operations rather than a documented public Anthropic API; their request and response shapes follow the implementation verified in [T3 Code v0.0.44](https://github.com/pingdotgg/t3code/blob/v0.0.44/apps/server/src/provider/Layers/claudeResetCredits.ts). Changes to those endpoints fail without claiming success.
