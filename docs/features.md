# What Tau does

The first builds of Tau set out to prove that Pi can stay the agent runtime while a desktop shell around it becomes independently extensible. This is what the workbench does with Pi today, across the core and the kits Tau ships. Other runtimes are in [Runtimes and tools](runtimes.md); other machines, the browser and the phone in [Hosts, machines and devices](hosts.md).

- real Pi SDK session with streamed text, thinking and tool events
- recent Pi threads across projects, including project identity, the Git branch Workspace Kit supplies, live activity, and a settled shelf
- optional Working section on desktop and web: enable **Separate working threads** in Settings → Thread rail to collect running active threads until they finish, fail or need an answer or approval. It starts off; pinned, snoozed, settled and archived threads keep their sections, and manual order and sibling groups stay saved. Connected machines use their reported activity. The compact phone list keeps its current layout
- searchable recent-project modal (`Cmd/Ctrl+P`) and extension-provided add-project sources
- working local-folder and Git-clone project flows, plus thread search (`/`)
- file index marked with the working tree's changes, and a Signals event stream
- full-window diff review (`Cmd/Ctrl+Shift+D`) with unified and split views, driven by a real `git diff`
- commit and push from the review, with the message editable before it runs
- composer-level model, thinking and access controls, plus a context dial wired to Pi's own usage and manual compaction
- composer autocomplete for Pi skills, prompt templates, and extension commands; skills are searchable as `$skill` or `/skill`, and the selected runtime adapter resolves the shorthand to its supported invocation form when sent
- `@` file mentions in the composer, expanded to the file's workspace-relative path the way Pi reads it
- `!` shell commands from the composer, run through the login shell with their output styled in the transcript
- prompt history that survives a restart, plus a search over it
- open the workspace in the user's own editor (`Cmd/Ctrl+O`) or terminal (`Cmd/Ctrl+J`), and the draft prompt in the editor (`Cmd/Ctrl+E`)
- a runtime per thread, with Pi as the default ([Which runtime a thread gets](runtimes.md#which-runtime-a-thread-gets))
- model picker with provider tabs, cross-provider search and favourites
- the branch in the thread's head is a menu: switch or create a branch, open, add or remove a worktree; "New thread" asks for the project first (the one in context selected, ↵ confirms), and the new thread's page (T3 Code's layout) offers project and machine ("Run on") as pills under its heading, and checkout (current or new worktree) and branch (a `tau/…` name or one from the prompt, the base with its fetch age, start from origin) above the composer
- enforced access levels: Tau's inline Pi extension gates workspace mutations and computer-control actions; read-only threads retain inspection tools, while ask-before-edits requires approval before clicks, typing, launches, shell commands, and file changes
- a Preview panel (`/preview <url>`, `Cmd/Ctrl+Shift+B`) showing a real browser view the host draws over the dock, and `preview_open/navigate/status/snapshot/screenshot/click/type/press/scroll/evaluate/wait_for/resize/set_appearance/recording_start/recording_stop` tools so the agent can read and drive the page it just changed; a floating picture of what an agent drives while the panel is hidden
- `request_takeover` for every runtime: when only the user can go on (a sign-in, a 2FA code, a captcha), a Your turn card above the composer brings the Preview, the driven app or a page in the user's own browser forward, offers to bring a signed-in session over from the user's browser, holds Computer Use, the Preview and evidence pictures, and Done hands control back
- built-in cross-platform computer use through `@amaster.ai/pi-computer-use` (Apache-2.0) and its bundled Cua Driver assets; safe mode excludes it, and an explicitly configured Pi package wins over Tau's bundled registration
- grouped command palette (`Cmd/Ctrl+K`) with arrow-key navigation, attributing every command to the extension that contributed it
- one settings page: workbench defaults, keybindings, and a click-through list of extensions rendered from the options each one declares
- Markdown rendering of messages: GFM tables, task lists, inline code, and syntax-highlighted code blocks with copy, all styled on the workbench palette; raw HTML is deliberately not enabled
- extension-provided tool renderers for reads, writes and shell commands
- thread title generation on a small model (the one the settings name, else one close to the thread's), automatic after the first prompt and manual on demand
- extension-free safe mode with empty layout slots collapsed

## Work on a side task

In a saved Pi thread, choose **Fork here** on a completed turn, or Fork on a
message. Enter an optional **Task for the new thread** and choose **Fork and
start**. **Stay in this thread** is checked by default, so the side task starts
while you keep working in the source. Leave the task empty for an ordinary fork.

The fork carries the conversation through the selected turn. In a Git project
it gets a separate branch and worktree; the dialog says whether the files come
from that turn's checkpoint or the branch's last commit. Outside Git it shares
the source folder. The task's first line becomes its title. If sending fails,
the fork and worktree remain, with the task saved in the fork's composer to retry.

The source's **Forks** menu opens its forks, and each fork links back to the
source beside its title. These links survive a restart and do not make a fork
a delegated agent. **Bring back to parent** puts a summary of work after the
fork point into the source's composer for review. It does not merge Git changes;
use the existing review and merge flow for those.

## Give a thread a goal

In a Codex or Claude Code thread, type `/goal <objective>` and send it. The
runtime works on the objective turn after turn until its own check says it is
met; Tau does not loop prompts for it. A **Goal** pill above the composer shows
where it stands: running (blue, with the tokens it used), paused, blocked,
budget reached, met (green, only when the runtime confirmed it), or not
confirmed when the run ended without a verdict. Click the pill for the
objective, tokens and turns, and to pause, resume or end it; `/goal pause`,
`/goal resume` and `/goal end` do the same from the keyboard.

**Stop** (or Escape) stops the turn and pauses a Codex goal before its next
turn starts. Claude Code cannot pause a goal: Stop ends the turn and the goal
stays set until you end it. A line under the stopped turn says what Stop
ended, and whether anything may still wake the thread. After a restart a Codex
goal that was running shows as paused until you resume it; a Claude Code goal
shows as not confirmed. Pi threads have no native goals.

## Reopen a closed tab

`Cmd/Ctrl+Shift+T` brings back the stage tab closed last in this thread, and
**All tabs** lists the last twenty under **Recently closed**. Files and threads
come back as they were. A terminal tab comes back as a new shell in the
thread's folder; the shell you closed went back to the Terminal panel. Each
thread keeps its own list, with its tabs. Transcript detail moved to
`Cmd/Ctrl+Alt+T`.

## Watch a pull request

The eye segment in a PR's existing strip or workspace card starts a GitHub
watch in one click. Its state shows the wake count; click it to stop or inspect
the last read. Changes queue a marked wake instead of interrupting a turn. Stop
ends the watches; Settle ends them until its undo. See [Pull request watches](pr-watch.md).

## Automations and private webhook keys

Open **Automations** to save a prompt for a known project and runtime. The form
configures and enables a daily, one-off or signed webhook trigger. Needs you,
Running, Scheduled and Off groups show what can happen next. Open last thread
returns directly to the conversation. Uncertain recovery defaults to Skip;
retrying requires acknowledging possible duplicate work.

Private webhook keys are entered in a masked field, stored in the host's OS
secret store and kept out of agent messages. A tool's pending request appears
above the composer without taking an unsent draft. Stop or Decline ends it.
Automation management and private-key entry use the host's own window; paired
devices can inspect jobs and open their threads. See [Scheduling](scheduling.md).
