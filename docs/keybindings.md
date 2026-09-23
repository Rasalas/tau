# Keybindings

Tau's default chords follow T3 Code's wherever Tau has the command. `mod` is ⌘
on macOS and Ctrl elsewhere. A `when` clause says where a chord applies; where
two bindings share a chord, the one whose context the keyboard is in wins
(see "Keybindings" in [`EXTENSIONS.md`](EXTENSIONS.md) for the rules).
Settings → Keybindings lists what is live, with its clause.

## Rebinding

Chords live in Pi's `~/.pi/agent/keybindings.json`, by Pi action id or Tau
command id; the file is watched, so a save applies at once.

```json
{
  "app.session.new": "mod+t",
  "terminal.split": { "key": "mod+\\", "when": "terminalFocus && !stageFocus" },
  "review.toggle": ["mod+d", { "key": "mod+shift+g", "when": "true" }]
}
```

A chord you write replaces the command's defaults. Without `when` it keeps the
clause of the default it replaces (a rebound `terminal.split` still only
splits inside a terminal); `"when": "true"` makes it apply everywhere. Pi reads
only the string entries, so an entry with an object in it is Tau's alone.

Contexts: `terminalFocus`, `editorFocus`, `previewFocus`, `composerFocus`,
`stageFocus`, `modelPickerFocus`, and the matching `…Open` (`modelPickerOpen`,
`terminalOpen`, …). `editableFocus` holds while any text field, select or
`contenteditable` element has the keyboard. Any extension can add its own with
`data-keybinding-context`.

## Defaults

| Chord | When | Command | What it does | From | T3 Code |
| --- | --- | --- | --- | --- | --- |
| `mod+b` | | `workbench.toggle-sidebar` | Hide or show the sidebar | core | `sidebar.toggle` |
| `mod+alt+b` | | `workbench.toggle-dock` | Hide or show the dock | core | `rightPanel.toggle` |
| `mod+k` | | `runtime.command-palette` | Command palette | core | `commandPalette.toggle` |
| `mod+n` | `!terminalFocus` | `runtime.new-session` | New thread | core | `chat.new` |
| `mod+shift+o` | `!terminalFocus` | `runtime.new-session` | New thread | core | `chat.new` |
| `mod+shift+m` | | `runtime.model` | Model picker | core | `modelPicker.toggle` |
| `mod+alt+shift+a` | | `runtime.theme` | Cycle light, dark, system | core | `appearance.cycle` |
| `mod+w` | | `workbench.close-stage-tab` | Close the stage tab | core | `rightPanel.close` |
| `mod+,` | | `runtime.settings` | Settings | core | same |
| `mod+i` | | `runtime.instructions` | System prompt and instructions | core | – |
| `escape` | | `runtime.abort` | Stop the run | core | – |
| `mod+shift+enter` | `!terminalFocus` | `thread.steerQueuedMessage` | Send the oldest queued message now | core | same |
| `mod+shift+e` | `!terminalFocus` | `composer.effort` | Reasoning menu | core | same |
| `mod+shift+a` | `!terminalFocus` | `composer.mode` | Access menu | Access | same |
| `mod+shift+x` | `!terminalFocus` | `composer.workspace` | Where the thread runs | Workspace | same |
| `mod+shift+g` | `!terminalFocus` | `composer.branch` | Branch picker | Workspace | same |
| `mod+shift+t` | | `runtime.transcript-detail` | Cycle transcript detail | core | – |
| `mod+shift+r` | | `runtime.rename-thread` | Rename thread | core | – |
| `ctrl+p` | `composerFocus` | `runtime.cycle-model` | Next model (Pi's chord) | core | – |
| `shift+tab` | | `runtime.cycle-thinking` | Next thinking level | core | – |
| `ctrl+g` | | `runtime.open-prompt-editor` | Prompt in `$EDITOR` | core | – |
| `mod+alt+1` | | `workbench.focus-composer` | Focus the composer | core | – |
| `mod+alt+2` | | `workbench.focus-transcript` | Focus the transcript | core | – |
| `mod+alt+3` | | `workbench.focus-stage` | Focus the stage | core | – |
| `ctrl+tab` / `ctrl+shift+tab` | | `workbench.next-stage-tab` / `prev-stage-tab` | Move between stage tabs | core | – |
| `mod+j` | | `terminal.toggle` | Terminal panel | Terminal | same |
| `mod+d` | `terminalFocus && !stageFocus` | `terminal.split` | Split right | Terminal | `terminal.split` |
| `mod+shift+d` | `terminalFocus && !stageFocus` | `terminal.splitDown` | Split down | Terminal | `terminal.splitVertical` |
| `mod+n` | `terminalFocus` | `terminal.new` | New terminal | Terminal | same |
| `mod+w` | `terminalFocus && !stageFocus` | `terminal.close` | Close the terminal | Terminal | same |
| `mod+]` / `mod+[` | `terminalFocus && !stageFocus` | `terminal.focusNext` / `focusPrevious` | Next or previous pane | Terminal | – |
| `mod+d` | `!terminalFocus` | `review.toggle` | Open or close the review | Review | `diff.toggle` |
| `mod+shift+d` | | `review.open` | Open the review | Review | – |
| `mod+shift+j` | | `preview.toggle` | Preview panel | Preview | same |
| `mod+shift+b` | | `preview.open` | Open the preview panel | Preview | – |
| `mod+l` | `previewFocus` | `preview.focus-url` | Preview address | Preview | `preview.focusUrl` |
| `mod+p` | | `search.files` | Go to file | Search | `filePicker.toggle` |
| `mod+shift+f` | | `search.content` | Search in project | Search | `projectSearch.toggle` |
| `mod+s` | `editorFocus` | `files.save` | Save the file | Files | – |
| `mod+s` | `!terminalFocus` | `prompt-tools.stash` | Stash the draft | Prompt Tools | `composer.stash` |
| `mod+shift+[` / `mod+shift+]` | | `thread.prev` / `thread.next` | Previous or next thread | Thread Rail | `thread.previous` / `thread.next` |
| `mod+alt+arrowup` / `mod+alt+arrowdown` | | `thread.prev` / `thread.next` | Previous or next thread | Thread Rail | – |
| `mod+1` … `mod+9` | `!modelPickerOpen` | `thread.jump-1` … `thread.jump-9` | Thread 1–9 of the rail | Thread Rail | `thread.jump.1` … |
| `mod+shift+p` | | `thread.pin` | Pin or unpin | Thread Rail | same |
| `mod+shift+s` | | `thread.settle` | Settle or un-settle | Thread Rail | same |
| `mod+z` | `!terminalFocus && !editableFocus` | `thread.undo` | Undo the last unpin, settle, snooze, archive or delete | Thread Rail | same |
| `mod+o` | | `workspace.open-in-editor` | Open in the external editor | Workspace | `editor.openFavorite` |
| `mod+alt+p` | | `workspace.open-project` | Open a project | Workspace | – |
| `mod+alt+j` | | `workspace.open-terminal` | Open in the external terminal | Workspace | – |
| `mod+e` | | `workspace.open-prompt-editor` | Prompt in the external editor | Workspace | – |
| `mod+alt+a` | | `appearance.open` | Appearance settings | Appearance | `theme.select` |
| `mod+alt+shift+t` | | `appearance.toggle-theme-editor` | Theme editor | Appearance | `themeEditor.toggle` |
| `mod+alt+o` | | `observatory.open` | Signals panel | Signals | – |

Inside the model picker, `mod+1` … `mod+9` choose a numbered model and
`mod+shift+arrowup` / `arrowdown` move between providers, as in T3 Code; the
picker handles those keys itself. Without Thread Rail, Workspace Kit binds
`mod+shift+s` to its own "Settle thread".

Inside Files Kit's editor, CodeMirror's own chords come first: `mod+f` opens
search and replace, `mod+g` / `mod+shift+g` step through matches, `mod+d`
selects the next occurrence (not the review), `mod+alt+arrowup` /
`arrowdown` add a cursor (not thread navigation), `mod+i` selects the
enclosing syntax node, `mod+[` / `mod+]` indent, and the fold chords are
`mod+alt+[` / `mod+alt+]` on macOS and `ctrl+shift+[` / `]` elsewhere. `mod+s`
still saves, Escape closes the search or drops extra cursors and never stops
the run, and chords the editor does not use (`mod+k`, `mod+w`, `mod+p`, …)
reach the workbench as usual.

## Where Tau differs from T3 Code

- T3 Code scopes most global chords with `!terminalFocus`. Tau does that only
  where the terminal gives the chord its own meaning (`mod+n`, `mod+d`,
  `mod+w`) and for the stash. A shell keeps every key it handles anyway, and
  on macOS the ⌘ chords reach the workbench from a terminal, so `mod+k` opens
  the palette there.
- On the stage a terminal fills its tab: `mod+w` closes the tab, and the split
  and pane chords are not bound there.
- Stage tabs moved off `mod+shift+[`/`]` (now thread navigation, as in T3 Code)
  to `ctrl+tab`; the focus chords moved from `mod+1`–`mod+3` (now thread jumps)
  to `mod+alt+1`–`mod+alt+3`.
- `mod+r` and the zoom chords under `previewFocus` are not bound: Electron's
  View menu owns ⌘R, ⌘0, ⌘+ and ⌘− for the window.
- No Tau command yet for `chat.newLocal`, `composer.host`,
  `composer.previousWorktree`, `pullRequest.copyNumber`,
  `thread.copyReference` and `rightPanel.toggleMaximized`.
- T3 Code's `composer.mode` opens its runtime-mode menu, which is Tau's
  access level, so it opens Access Kit's menu. Plan mode is Plan Kit's
  `plan.toggle`, without a chord: T3 Code toggles it with ⇧Tab in the
  composer, which Tau keeps for Pi's thinking-level cycle.
- `composer.*` commands click the composer control that carries their id in
  `data-composer-shortcut`; a control another kit draws can answer the same way.
- Inside the composer ⌘⇧↵ sends the oldest queued message whatever the send
  setting, and leaves the draft where it is. "Switch
  project…" has no chord: T3 Code has no counterpart, and the palette finds
  projects.
