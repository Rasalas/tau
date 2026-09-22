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
| `model` | the parent's model on Pi, the runtime's default elsewhere | `provider/model-id`, as the model picker spells it. |
| `runtime` | `pi` | The runtime backend the thread runs on: `pi` or the kind a runtime kit registered (`claude-code`, …). The thread fails to start when no kit registered that kind. |
| `tools` | every tool | The only tools the thread keeps, as Pi names them (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, the `tau_*` tools, an extension's tools). A name the runtime does not have is ignored. Pi only. |
| `access` | the workbench's level | `read-only`, `ask` or `full`. It can narrow the level Access Kit gives the thread, never widen it. Pi only. |
| `workspace` | `worktree` in a Git repository | `worktree` for a checkout of its own, branched from the parent's state; `shared` to work in the parent's checkout — for an agent that only reads. |

The body below the second `---` is required. It is the agent's system prompt:
on Pi, Agents Kit appends it to the system prompt Pi builds, on every turn of
that thread, under `# Agent definition: <name>`. A runtime Tau cannot extend
reads it at the head of the thread's first message instead.

The frontmatter is a small subset of YAML: `key: value` lines, values quoted or
not, `#` comments, and lists either inline (`[read, grep]`), comma-separated
(`read, grep`) or as `- item` lines under an empty key. Anything else is an
error that names its line.

## Using one

- **From a thread.** `tau_spawn_thread` takes `agent`, the definition's name.
  A thread that may still spawn is told which definitions exist in its system
  prompt. A call's own `model` and `workspace` win over the definition's.
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
unknown `access`, `tools` on a runtime other than Pi, a name taken twice —
is listed in Settings → Inspector under PROBLEMS with its reason, and the
Agents panel says how many there are. An unknown field is a warning and is
ignored. A broken file never stops the others or a spawn without `agent`; a
spawn that names it fails with the same reason, and one that names no
definition at all lists the names there are. The palette's **Read agent
definitions again** reads the folder anew; the panel reads it whenever the
thread on screen changes.
