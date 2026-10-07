# Agent definitions: `.tau/agents/`

A repository can check in the agents its threads may start. Each one is a
Markdown file in `.tau/agents/` at the root of the checkout: a frontmatter
block for the settings, and the body as the agent's system prompt. Agents Kit
(`kits/agents/`) reads the folder; nothing else does.

```markdown
---
description: Reviews the current change and reports problems, nothing else
model: anthropic/claude-haiku-4-5-20251001
tools: [read, grep, find, ls]
access: read-only
workspace: shared
---
You review code. Read the diff the task names, list concrete problems with
file and line, and do not change any file.
```

Saved as `.tau/agents/reviewer.md`, this is the agent `reviewer`.

| Field | Default | Meaning |
|---|---|---|
| `name` | the file name without `.md` | Lowercase letters, digits, `-` and `_`, at most 64. Two files may not share one; the first in alphabetical order keeps it. |
| `description` | required | When to use it. The Agents panel shows it, and a thread that may spawn is told it. |
| `model` | the parent's model | `provider/model-id`, as the model picker spells it. |
| `runtime` | the parent's runtime | The runtime backend the thread runs on: `pi` or the kind a runtime kit registered (`claude-code`, …). The thread fails to start when no kit registered that kind. |
| `tools` | every tool | The only tools the thread keeps, as Pi names them (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, the `tau_*` tools — `mcp__tau__tau_*` reads the same — an extension's tools). A name the runtime does not have is ignored. See below for other runtimes. |
| `access` | the workbench's level | `read-only`, `ask` or `full`. It can narrow the level Access Kit gives the thread, never widen it. Pi only. |
| `workspace` | `worktree` in a Git repository | `worktree` for a checkout of its own, branched from the parent's state; `shared` to work in the parent's checkout — for an agent that only reads. |
| `machine` | Settings → Agents (this computer unless the user chose otherwise) | Where the thread runs: another machine this computer's agents reach, by name or host id (`rex`); `local` for this computer; `auto` to let Tau pick by load. On another machine it works in a worktree there with the parent's state, and its work comes back here as a branch. A definition that sets `tools` or a narrower `access` cannot run elsewhere, since that machine never sees the definition. |

The body below the second `---` is required. It is the agent's system prompt:
on Pi, Agents Kit appends it to the system prompt Pi builds, on every turn of
that thread, under `# Agent definition: <name>`. A runtime Tau cannot extend
reads it at the head of the thread's first message instead.

The frontmatter is a small subset of YAML: `key: value` lines, values quoted or
not, `#` comments, and lists either inline (`[read, grep]`), comma-separated
(`read, grep`) or as `- item` lines under an empty key. Anything else is an
error that names its line.

## `tools` on another runtime

A runtime other than Pi narrows its own tools as far as it can, and a runtime
that cannot refuses the spawn with that reason:

- **Codex** keeps its shell for any of `bash`, `read`, `grep`, `find`, `ls`
  (it reads through the shell) and runs in its read-only sandbox unless the
  list names `bash`, `edit` or `write`, whatever the workbench's level. Web
  search and image viewing stay only when listed as `web_search` and
  `view_image`; image generation, apps, plugins and goals are off. What
  codex-cli 0.154 cannot switch off stays: its patch tool (refused by the
  read-only sandbox), its question to the user, and its own sub-agents, which
  run under the thread's configuration. MCP servers from the user's
  `config.toml` stay too.
- **The Agent SDK runtime** gets Claude's tools by their Pi names (`read` →
  `Read`, `grep` → `Grep`, `find` and `ls` → `Glob`, `bash` → `Bash`, `edit` →
  `Edit`, `write` → `Write`) or Claude's own (`WebFetch`), and no MCP server but
  Tau's; the user's own servers are left out.
- **Antigravity** cannot narrow its tools; such a definition fails to spawn.

On every runtime Tau's own tools over MCP are only the `tau_*` names listed.

## Native delegation

Codex and Claude Code delegate natively inside the parent conversation. Configure
native agent roles, models and limits in Codex's agent configuration or Claude
Code's `.claude/agents/` definitions. Tau preserves the runtime's user and project
configuration; explicit launch options override Tau's feature defaults.

The definition picker can send a simple `.tau/agents/` persona and requested
model to the native parent for delegation. A definition with `tools`, `access`,
`workspace` or `machine` is rejected there: configure those restrictions natively
so the runtime enforces them. A definition choosing a different runtime requires
a conversation on that runtime. It does not create another Tau thread.

Native child activity appears in the parent's Agents rows and cards. Clicking
expands the transcript inside that conversation. A separate Tau conversation is
created only on an explicit user request through `tau_create_thread`.

The remaining sections describe the hidden Tau-thread fallback used when the
parent runtime has no native delegation. Fallback and older child transcripts
open as read-only previews, without changing the active conversation.

## Using one

- **From a thread.** `tau_spawn_thread` takes `agent`, the definition's name.
  A thread that may still spawn is told which definitions exist in its system
  prompt. A call's own `model`, `workspace` and `machine` win over the definition's.
- **From the Agents panel.** The panel lists the definitions of the checkout on
  screen above the running agents, each with what it runs already. **Start**
  asks for a task and starts the agent as a child of the thread on screen, the
  same way a spawn from that thread would.

Either way the new thread is an ordinary spawned thread (ADR 0013): it shows
in the Agents panel and on the spawn card with the definition's name beside its
title, and it can be read, waited for and applied back like any other.

## What is kept where

The child's own link entry — the one `sessions.start({ parent })` writes
before its first prompt — carries `agent` and `persona`: the name, the file,
the system prompt, `tools` and `access`. The persona therefore travels with
the thread: editing or deleting the file later changes new agents, not the
ones already running, and a restart reads the persona back from the session.
A thread of another runtime has no Pi session file; only its first message
carries the persona.

`access` is applied through Access Kit's `thread-level` command, which names
Agents Kit as its one caller. Without Access Kit nothing could gate the
thread, so a `read-only` or `ask` agent loses `edit`, `write` and `bash`
instead.

## Problems

A file that cannot be used — no frontmatter, a missing `description`, an
unknown `access`, `access` on a runtime other than Pi, a name taken twice —
is listed in Settings → Inspector under PROBLEMS with its reason, and the
Agents panel says how many there are. An unknown field is a warning and is
ignored. A broken file never stops the others or a spawn without `agent`; a
spawn that names it fails with the same reason, and one that names no
definition at all lists the names there are. The palette's **Read agent
definitions again** reads the folder anew; the panel reads it whenever the
thread on screen changes.
