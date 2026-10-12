# What Tau does

The first builds of Tau set out to prove that Pi can stay the agent runtime while a desktop shell around it becomes independently extensible. This is what the workbench does with Pi today, across the core and the kits Tau ships. Other runtimes are in [Runtimes and tools](runtimes.md); other machines, the browser and the phone in [Hosts, machines and devices](hosts.md).

- real Pi SDK session with streamed text, thinking and tool events
- recent Pi threads across projects, including project identity, the Git branch Workspace Kit supplies, live activity, and a settled shelf
- agents see and organise the thread list: `tau_find_threads` lists threads with settled, snoozed (and until when), pinned and running state, the pull requests they link and a link to paste; `tau_thread_organize` settles or snoozes a thread, and on its own thread the change lands when the turn ends well. A `tau://thread` link in a message is drawn as a chip with the thread's current title and opens it
- the palette finds a thread by the pull or merge request it links (`#95`, `owner/repo#95`, the URL or the branch), and an empty palette shows the recent threads with the ones waiting for you first
- optional Working section on desktop and web: enable **Separate working threads** in Settings → Thread rail to collect running active threads until they finish, fail or need an answer or approval. It starts off; pinned, snoozed, settled and archived threads keep their sections, and manual order and sibling groups stay saved. Connected machines use their reported activity. The compact phone list keeps its current layout
- searchable recent-project modal (`Cmd/Ctrl+P`) and extension-provided add-project sources
- working local-folder and Git-clone project flows, plus thread search (`/`)
- find in the thread (`Cmd/Ctrl+F` or `/` in the transcript) searches the whole history, also turns not loaded yet and a reply's plan: it starts at the newest match (Enter goes to the next older one, Shift+Enter back), loads older turns on the way, marks the words in the text and the row it stands on
- a quote sent from a reply or a terminal reads as a chip above the message (what you wrote about it, else the start of the quote); a click opens the source, the quote and your comment, and "Go to source" jumps to the cited reply
- file index marked with the working tree's changes, and a Signals event stream
- full-window diff review (`Cmd/Ctrl+Shift+D`) with unified and split views, driven by a real `git diff`
- commit and push from the review, with the message editable before it runs
- composer-level model, thinking and access controls, plus a context dial wired to Pi's own usage and manual compaction
- the Usage page's Runtime filter is a set of switches in the sidebar (marks in the sheet on a phone): switch any runtime off and the totals, charts, rankings, plan limits and accounts leave it out; a plan shared by two runtimes shows once for the one left. The runtimes switched off are kept on the device, so a runtime that appears later is shown. While a runtime's first read of the CLIs' logs is under way, only its rows and the totals it adds to dim, not the whole page
- composer autocomplete for Pi skills, prompt templates, and extension commands; skills are searchable as `$skill` or `/skill`, and the selected runtime adapter resolves the shorthand to its supported invocation form when sent
- several skills in one message (Pi runtime): pick as many as the message needs, at the start or further into the sentence (`$tdd`, then "…and check it with `$lint`"); every one loads, the text goes as typed (the skills at the start leave it for their chips, the others stay in the sentence), each skill is a chip in the composer and in the sent message, and copying the message gives the skills' commands and the text, which pastes back as the same message. A runtime that takes one skill keeps `$skill` to the start of the text
- `@` file mentions in the composer, expanded to the file's workspace-relative path the way Pi reads it
- `!` shell commands from the composer, run through the login shell with their output styled in the transcript
- prompt history that survives a restart, plus a search over it
- open the workspace in the user's own editor (`Cmd/Ctrl+O`) or terminal (`Cmd/Ctrl+J`), and the draft prompt in the editor (`Cmd/Ctrl+E`)
- a runtime per thread, with Pi as the default ([Which runtime a thread gets](runtimes.md#which-runtime-a-thread-gets))
- a runtime can be turned off for one project, or on for one while the machine has it off, with a switch on its Providers card ([Turning a runtime off for a project](runtimes.md#turning-a-runtime-off-for-a-project)); the app refuses every start on it there, the pickers leave it out, and update checks skip a runtime no project uses
- model picker with provider tabs, cross-provider search and favourites
- the branch in the thread's head is a menu: switch or create a branch, open, add or remove a worktree; "New thread" asks for the project first (the one in context selected, ↵ confirms), and the new thread's page (T3 Code's layout) offers project and machine ("Run on") as pills under its heading, and checkout (current or new worktree) and branch (any name, or one from the prompt; the same field fuzzy-searches the base, `origin/main` by default) above the composer; the first thread of a project made from "New project" starts in its folder whatever the default for new threads is
- enforced access levels: Tau's inline Pi extension gates workspace mutations and computer-control actions, and tools from other sources (extensions, packages, MCP) unless they declare themselves read-only; read-only threads retain inspection tools, while ask-before-edits requires approval before clicks, typing, launches, shell commands, and file changes
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

## Ask a side question

Type `/btw <question>` in a thread, or choose **Ask a side question…** in the
thread's menu (it takes what is typed in the composer as the question). The
answer streams into its own tab beside the conversation and stays there until you
close the tab, so several questions can stay open. The question is answered from
the conversation so far, including what the agent ran, by the thread's own model,
without tools; it does not join the thread, so the thread's history, queue and
cost are as before, and you can ask while the agent is working. A question that
failed has **Retry**.

**Continue as side task** turns a good answer into real work. In a Pi thread it
opens the same fork question as **Fork here** (branch and worktree, **Task for
the new thread** already holding the question and its answer), and the fork
starts from the point where you asked. In a thread of another runtime it starts a
new thread on that runtime with a summary of the conversation, and the question
waits in its composer.

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

## Right-click menus in the terminal and the preview

A terminal's menu has Copy, Paste, **Select all** (the whole scrollback) and
**Jump to latest**; the same two work from the keyboard (see
[Keybindings](keybindings.md)). The Preview's page has a native menu too: on a
link, **Open Link in Browser** (web links only) and **Copy Link Address**; on an
image, **Copy Image** and **Copy Image Address**; on a selection or in a field,
the usual edits. Images inside a frame of another site are read by their
address, with no cookies and at most 32 MiB.

## The `tau` command from Settings

Settings → General → **Terminal command** puts `tau` on your terminal's `PATH`
after asking which folder it links into, shows where it is installed and
whether a new terminal finds it, and **Remove** undoes it. An existing `tau`
is never replaced. See [Install](install.md#the-tau-command).

## Reorder stage tabs

Drag a stage tab along the strip and let it go: a line shows where it lands, in
front of the tab under the pointer or last. The order is kept with the thread's
stage, and "Close to the right" follows it. A tab let go below the strip still
splits the stage; letting go on the strip never does.

## MCP Apps in a Codex thread

When an MCP server in a Codex thread offers an interactive view of a tool's
result (an MCP App), the tool's row in the transcript becomes that view. It runs
in an isolated frame: it cannot read the workbench, its storage or your host
connection, reaches only the web origins its server declared, and cannot leave
its page. The view is kept with the thread, so it opens again after a restart;
buttons that call the server work while the thread's Codex session runs, and
otherwise say so (send a message in the thread to start it again).

What an app does on its own: reads and calls to tools the server marks read-only
run without asking. A tool that is not read-only, a message the app wants to
send as you, and a file it wants to save each ask first in a card above the
composer, with the tool's full arguments, on every device the thread is open on.
An app can ask for full screen (it keeps its state; Escape, or a question from
the agent, brings it back inline), size itself between 80 and 2000 px, and open a
link only right after you clicked inside it. What an app tells the model
(`ui/update-model-context`) goes with your next message as data from that
server, marked untrusted. See [ADR 0032](adr/0032-sandbox-frame-and-mcp-apps.md).

## Pages an agent writes

An agent can answer with a page instead of text: a chart, a diagram, a mockup, a
gallery. It writes one HTML document (or a file in the project) and calls
`show_html_page`; the page appears in the thread above its reply, on every
runtime and on the phone and web client too. Scripts run inside the page, but it
is sandboxed away from Tau and your session, and it cannot reach the network:
a chart library loads only from an https host the agent declared, and the card
shows which. Local images are embedded when the page is made, so it keeps
working after the files move. A link opens in your browser after you click it.
The expand button shows the page full size without restarting it; "Open in a
tab" puts it on the stage (it starts over there). Pages belong to their thread
and go when the thread is deleted. See [ADR 0035](adr/0035-agent-pages-on-the-sandbox-frame.md).

## Reopen a closed tab

`Cmd/Ctrl+Shift+T` brings back the stage tab closed last in this thread, and
**All tabs** lists the last twenty under **Recently closed**. Files and threads
come back as they were. A terminal tab comes back as a new shell in the
thread's folder; the shell you closed went back to the Terminal panel. Each
thread keeps its own list, with its tabs. Transcript detail moved to
`Cmd/Ctrl+Alt+T`.

## Read a pull request

The comments of a pull or merge request come with a **Filter** menu, in the
Summary and in the Timeline: bot comments and resolved or dismissed ones start
hidden, the button says how many it holds back ("14 hidden"), and the choice is
kept for every request. On GitHub a bot is told by its account type, not by a
`[bot]` suffix. In the Changes and Code views a bar of unchanged lines sits
between the hunks, above the first and below the last: the arrows show 20 more
lines, the middle shows them all. Tau reads the file at the request's head
commit from the host (GitHub, GitLab, Forgejo, Bitbucket, Azure DevOps), only
ever reading, and the revealed lines carry no comment button, since hosts take
comments on the diff's own lines only. `Cmd/Ctrl+F` inside a diff (the review
overlay, the Code tab, the Reviews page's Changes) opens a find bar over every
loaded file, folded ones included: Enter and Shift+Enter step through the
matches, the file of the active one unfolds or is selected, and the switches
match case, whole word or a regular expression. A diff that Tau loads in pages
is searched as far as it is loaded.

## Review a pull request with a guide (beta)

Turn on **Settings → Review → Review guides** and a GitHub pull request gets a
**Guide** tab. Opening it costs nothing; **Write guide** starts one run: a
read-only agent, visible in the Agents panel, reads the request's head in a
worktree of its own and writes a tour of two to eight stops in reading order. Each
stop says what it accomplishes, shows only the lines that carry the idea, letters
its notes A, B, C, and names the one call you should make there (a tradeoff, a
contract, a product call, a risk, an accessibility call) where there is one. You
can leave while it reads; Tau tells you when it is ready, and a phone that is away
gets a push. **J** and **K** step through the stops, a line you select in an
excerpt goes into the same review the Code tab collects, unchanged lines load from
the bars above and below, **Ask about this stop** (or one of its questions) hands
the stop to the thread you are reading, and **Finish review** on the last stop
opens the review composer with everything you collected. On a phone the tour is an
outline and one screen per stop.

A guide is kept per request, not per thread. After a push the tab says "Written
before the latest push" and offers **Rewrite**; nothing rewrites it by itself. The
model that writes guides is chosen on Review Kit's page under Extensions, and
**Guide instructions** in Settings → Review say what you want every guide to favour.
Agents can start guides for up to twenty requests (`write_pull_request_guides`) and
read them (`read_pull_request_guide`, with whether the guide is stale). A guide is
written from a thread in a checkout of the request's repository.

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
