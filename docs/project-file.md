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
| `worktreeDirectory` | Workspace Kit | Where worktrees go, e.g. `"~/.tau/worktrees"`; beside the repository when absent. |
| `worktreeSubmodules` | Workspace Kit | How a new worktree fills its submodules: `"recursive"` (the default), `"top-level"` (only the ones this repository declares) or `"none"` (leave them to a setup script). Read from the branch being checked out; Settings → Source control → Submodules wins when it names a value. |
| `scripts` | Project Scripts | Quick actions, below. |
| `runOnWorktreeCreate` (a string) | Project Scripts, else Workspace Kit | The old spelling of a setup script. It still runs, as a blocking script with the id `setup`, and the Inspector suggests moving it into `scripts`. |

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
Settings → Inspector under PROBLEMS, and the bar shows a chip while there are
errors. A file that is not JSON loads no scripts.

Tau re-reads the file when it changes on disk (not under `TAU_NO_WATCH=1`), and
"Read .tau/project.json again" in the palette does it by hand.
