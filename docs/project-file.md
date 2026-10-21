# The project file: `.tau/project.json`

A repository describes what its threads do in one checked-in file,
`.tau/project.json` at the root of the checkout. Every field is optional, a
missing file means Tau's defaults, and each field belongs to the kit that reads
it. [`schemas/project.schema.json`](schemas/project.schema.json) is the JSON
Schema; point your editor at it (VS Code: `json.schemas`, or a `$schema` key
with a path or URL to the file).

```json
{
  "workspaceMode": "worktree",
  "scripts": [
    { "name": "Install", "command": "npm ci", "icon": "configure", "runOnWorktreeCreate": true, "async": false },
    { "name": "Dev server", "command": "npm run dev", "keybinding": "mod+shift+r", "previewUrl": "http://localhost:5173" },
    { "name": "Test", "command": "npm test", "icon": "test" }
  ]
}
```

| Field | Read by | Meaning |
|---|---|---|
| `workspaceMode` | Workspace Kit | `"current"` or `"worktree"`: where a new thread runs by default ([ADR 0017](adr/0017-worktrees-for-threads-and-agents.md)). |
| `worktreeDirectory` | Workspace Kit | Where new worktrees go. Absent uses Tau's central worktrees folder; `"beside"` uses `<repo>-worktrees` beside the repository. A path such as `"~/worktrees"` overrides the location. |
| `worktreeSubmodules` | Workspace Kit | How a new worktree fills its submodules: `"recursive"` (the default), `"top-level"` (only the ones this repository declares) or `"none"` (leave them to a setup script). Read from the branch being checked out; Settings → Source control → Submodules wins when it names a value. |
| `scripts` | Project Scripts | Quick actions, below. |
| `runOnWorktreeCreate` (a string) | Project Scripts, else Workspace Kit | The old spelling of a setup script. It still runs, as a blocking script with the id `setup`, and the Inspector suggests moving it into `scripts`. |

## Worktree storage

New worktrees default to `~/.tau/worktrees/<repository>-<path hash>.noindex/`.
Tau Dev uses `~/.tau-dev/worktrees/`. The main checkout's canonical path determines
the bucket, so linked worktrees share it and same-named clones stay separate.
The `.noindex` directory suffix excludes the default bucket from macOS Spotlight.
Apple documents this behavior when [locating debug symbol files](https://developer.apple.com/documentation/xcode/locating-a-missing-debug-symbol-file).

On Linux, the hidden Tau folder keeps worktrees out of GNOME LocalSearch/Tracker
and KDE Baloo with their default settings. Tau also creates `.nomedia` in each
central bucket before filling it, a [GNOME directory exclusion marker](https://gnome.pages.gitlab.gnome.org/localsearch/indexed-data.html).
Baloo has no equivalent local marker. If hidden folders are explicitly indexed,
exclude Tau's worktrees folder in [KDE File Search](https://docs.kde.org/stable_kf6/en/plasma-desktop/kcontrol/baloo/index.html).
Tau leaves the desktop's global search settings alone.

Settings → Source control → Worktrees under changes the machine's location.
The project file takes precedence; `TAU_WORKTREES_DIR` overrides the machine's
saved setting. Custom paths retain their existing layout: Tau appends the
repository name unless the path already ends with it, or substitutes `{project}`
where present. Exclude a custom folder through your desktop's search settings;
on macOS use [Spotlight search privacy](https://support.apple.com/guide/mac-help/mchl1bb43b84/mac).

Existing worktrees stay at their recorded paths. Threads, runtime sessions and
tools can still refer to those paths, and a worktree can hold local changes.
Tau therefore neither moves nor discards them on upgrade. Settings → Storage
continues to list and clean up recorded worktrees in the previous beside-project
location, with the existing opt-in rules and Git protections. Newly recorded
worktrees retain their approved parent even if the location setting later changes.
Reopening a cleaned-up thread recreates its checkout at its original path.

## Scripts

Each entry of `scripts` becomes a button in the bar above the composer, in file
order, and a command `script.<id>.run` in the palette.

| Field | Default | Meaning |
|---|---|---|
| `name` | required | Label of the button and the command. |
| `command` | required | Shell command, run with `/bin/sh -c` in the thread's checkout — its worktree when it has one. `TAU_PROJECT_ROOT` and `TAU_SCRIPT_ID` are set. |
| `id` | the name, lowercase, dashes | Stable id: lowercase letters, digits and dashes, at most 40. Two scripts may not share one. |
| `icon` | `play` | One of `play`, `test`, `lint`, `configure`, `build`, `debug`. |
| `keybinding` | none | A chord in the workbench's spelling (`mod+shift+r`; `mod` is ⌘ on macOS, Ctrl elsewhere) bound to `script.<id>.run`. |
| `runOnWorktreeCreate` | `false` | Run once in every worktree Workspace Kit creates for a new thread, with `TAU_WORKTREE_PATH` set too. |
| `async` | `true` | With `runOnWorktreeCreate`: `false` holds the new thread until the script exits. |
| `previewUrl` | none | An `http(s)` page the script serves. The run card gets a preview button, and the Preview panel opens on it once the URL answers (waiting up to 30 s). |
| `autoOpenPreview` | `true` | `false` leaves opening the preview to the card's button. |

A run is a job: its card shows the output as it arrives, then the exit code and
how long it took; a failure opens its output and raises a notice. A script that
is already running in that checkout is not started twice. Running scripts stop
when the host leaves the workspace or the kit goes away. The `…` menu of the bar
also types a script into a Terminal Kit shell, for one you want to talk to.

## The worktree setup

Before running setup commands from an unapproved project file, Tau asks
**Allow project setup commands?** and shows the commands. **Skip setup**, closing
the dialog, or having no connected client to approve a new definition leaves the worktree
available without running these commands. This applies to `scripts` with
`runOnWorktreeCreate` and to the legacy command string, including when Project
Scripts is disabled and when Remote Work creates a worktree on another host.
Approval is asked on that host.

Approval belongs to this project on this host and is stored in Tau's own state,
outside the repository. It is bound to a SHA-256 hash of the script definitions,
the legacy setup command, `workspaceMode` and `worktreeDirectory`. Changing
these fields requires approval again; changing formatting does not. A change
while the dialog is open invalidates its answer. Trust for project extensions
and the thread's access level do not grant this separate permission. Setup commands
run with the host's environment, so review the commands before approving them.

Until the current definitions are approved, Tau ignores the file's
`workspaceMode`. The user's per-project choice and global default still apply,
and a worktree can be chosen explicitly. Clicking a script button or running
its palette command remains an explicit action.

When Workspace Kit creates a worktree for a new thread, the steps show as one
card under the thread's transcript: fetching
the base branch, creating the worktree, filling its submodules when it has any
(`worktreeSubmodules`; a failure there is marked and the setup goes on), then
every `runOnWorktreeCreate` script with its elapsed time and its last four lines of output. A blocking
script (`"async": false`) holds the first prompt; the card offers **Cancel**,
which stops the setup's scripts and lets the thread start in the worktree
without them, and **Start now**, which lets it start while the script runs on.
An `"async": true` script never holds the prompt, and its step keeps running on
the card while the agent works. A setup that finished cleanly leaves the
transcript; a failed or cancelled one stays until it is dismissed. The runs
also appear in the bar above the composer, tagged `setup`.

## When the file is wrong

A script with a missing `name` or `command`, a bad `id` or a taken one is
skipped; the others still load. Fields Tau does not know, an unknown icon or a
`previewUrl` that is not `http(s)` are warnings. All of them are listed in
Settings → Diagnostics under PROBLEMS, and the bar shows a chip while there are
errors. A file that is not JSON loads no scripts.

Tau re-reads the file when it changes on disk (not under `TAU_NO_WATCH=1`), and
"Read .tau/project.json again" in the palette does it by hand.
