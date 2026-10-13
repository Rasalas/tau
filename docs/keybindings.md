# Keybindings

Tau's default chords follow the conventions agent workbenches share, and a
command those workbenches also have often keeps their command id. `mod` is ⌘
on macOS and Ctrl elsewhere. A `when` clause says where a chord applies; where
two bindings share a chord, the one whose context the keyboard is in wins
(see "Keybindings" in [`EXTENSIONS.md`](EXTENSIONS.md) for the rules).
Settings → Keybindings lists what is live, with its clause.

## Rebinding

Settings → Keybindings edits the chords: click a chord and press the new
keys, change where it applies (the `when` field suggests the contexts in use
and checks the clause), add another chord or remove one of several, reset a
command to its default, or reset all. Before a save the page names every
binding that would press the same keys where both clauses hold, on this
platform and on the other (`mod+p` is `ctrl+p` off macOS), and says which of
the two gets the key. The keyboard button beside the filter searches by keys
instead of text. While a chord is being recorded no workbench chord runs.

The chords live in Pi's `~/.pi/agent/keybindings.json`, by Pi action id or Tau
command id; the file is watched, so a save from the page or from an editor
applies at once. The page writes the whole file anew with a temp file and a
rename, keeps every entry it did not change, writes where a symlink points
(a dotfiles checkout keeps the change), and leaves a file that is not a JSON
object alone.

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

The page writes under the Tau command id. Where the file also names the
command through a Pi action (`app.session.new` for `runtime.new-session`), the
entry under the command id wins in Tau and Pi keeps its own key; an empty list
(`"runtime.new-session": []`) gives the command Tau's defaults. Reset all
drops every entry that is not a Pi action (`app.*`, `tui.*`) and writes that
empty list for a command a Pi action still names.

Contexts: `chatFocus` (the transcript and the composer), `terminalFocus`,
`editorFocus`, `previewFocus`, `composerFocus`, `stageFocus`,
`modelPickerFocus`, and the matching `…Open` (`modelPickerOpen`,
`terminalOpen`, …). `editableFocus` holds while any text field, select or
`contenteditable` element has the keyboard; `overlayOpen` while a menu,
popover, picker, dialog, sheet or app page (Usage, Pull requests) is open.
`isDesktop` holds in the Electron window and not in a browser tab, on a phone
or on a tablet (see "In a browser tab" below). Any extension can add its own with
`data-keybinding-context`.

Escape closes the topmost overlay and does nothing else: no chord without a
modifier runs while an overlay is open, whatever its `when` says. Escape
stops a running turn only with no overlay open and the keyboard in the chat;
in the transcript, Escape first goes back to the composer.

The transcript is one tab stop with a cursor on one message: `↑`/`↓` (or
`j`/`k`) move it, and its ring hugs the message (the prompt's bubble, the
answer's text). `→` walks into that message's actions (Copy, Edit from here,
Fork, a package's own), `←`/`→` move along them, and `←` on the first or
`Escape` goes back to the message; `↑`/`↓` from an action go on to the
previous or next message. Tab leaves the transcript, as it leaves any
composite widget. The ring shows for the keyboard only (`:focus-visible`).

## Defaults

| Chord | When | Command | What it does | From |
| --- | --- | --- | --- | --- |
| `mod+b` | | `workbench.toggle-sidebar` | Hide or show the sidebar | core |
| `mod+alt+b` | | `workbench.toggle-dock` | Hide or show the dock | core |
| `mod+alt+shift+b` | | `rightPanel.toggleMaximized` | Maximize the panel in front onto the stage, or move it back | core |
| `mod+k` | | `runtime.command-palette` | Command palette | core |
| `mod+n` | `!terminalFocus && isDesktop` | `runtime.new-session` | New thread in the project on screen | core |
| `mod+shift+n` | `!terminalFocus && isDesktop` | `runtime.new-session` | New thread in the project on screen | core |
| `mod+shift+o` | `!terminalFocus` | `runtime.new-session-in` | New thread in a project chosen in the picker | core |
| `mod+shift+m` | | `runtime.model` | Model picker | core |
| `mod+alt+shift+a` | | `runtime.theme` | Cycle light, dark, system | core |
| `mod+w` | `isDesktop` | `workbench.close-stage-tab` | Close the stage tab | core |
| `mod+shift+t` | `!terminalFocus && isDesktop` | `workbench.reopen-stage-tab` | Reopen the tab closed last on this thread's stage | core |
| `mod+,` | | `runtime.settings` | Settings | core |
| `mod+i` | | `runtime.instructions` | System prompt and instructions | core |
| `mod+f` | `!terminalFocus && !previewFocus && !editorFocus && !overlayOpen` | `thread.find` | Find in the thread, from the composer too | core |
| `escape` | `chatFocus` | `runtime.abort` | Stop the run | core |
| `mod+shift+enter` | `!terminalFocus` | `thread.steerQueuedMessage` | Send the oldest queued message now | core |
| `mod+shift+e` | `!terminalFocus` | `composer.effort` | Reasoning menu | core |
| `mod+shift+a` | `!terminalFocus` | `composer.mode` | Access menu | Access |
| `shift+tab` | `composerFocus && editableFocus && !overlayOpen` | `plan.toggle` | Switch between plan and build mode, with the caret in the prompt | Plan |
| `mod+shift+x` | `!terminalFocus` | `composer.workspace` | Where the thread runs | Workspace |
| `mod+shift+g` | `!terminalFocus` | `composer.branch` | Branch picker | Workspace |
| `mod+alt+t` | | `runtime.transcript-detail` | Cycle transcript detail | core |
| `f2` | `!terminalFocus` | `runtime.rename-thread` | Rename thread | core |
| `mod+alt+k` | | `runtime.compact` | Compact the thread's context | core |
| `mod+\` | | `workbench.split-stage` | Split or join the stage | core |
| `mod+shift+\` | | `workbench.toggle-spine` | Collapse the conversation to its spine, or open it | core |
| `ctrl+p` | `composerFocus` | `runtime.cycle-model` | Next model (Pi's chord) | core |
| `ctrl+g` | | `runtime.open-prompt-editor` | Prompt in `$EDITOR` | core |
| `mod+alt+1` | | `workbench.focus-composer` | Focus the composer | core |
| `mod+alt+2` | | `workbench.focus-transcript` | Focus the transcript | core |
| `mod+alt+3` | | `workbench.focus-stage` | Focus the stage | core |
| `ctrl+tab` / `ctrl+shift+tab` | `isDesktop` | `workbench.next-stage-tab` / `prev-stage-tab` | Move between stage tabs | core |
| `mod+[` / `mod+]` | `!terminalFocus` | `navigation.back` / `navigation.forward` | Back or forward over the threads and subagents shown, as in a browser (T3 Code's ids) | core |
| `mod+j` | | `terminal.toggle` | Terminal panel | Terminal |
| `mod+d` | `terminalFocus && !stageFocus` | `terminal.split` | Split along the longer side: top and bottom in a pane taller than wide, else side by side | Terminal |
| `mod+shift+d` | `terminalFocus && !stageFocus` | `terminal.splitDown` | Split down | Terminal |
| `mod+n` | `terminalFocus && isDesktop` | `terminal.new` | New terminal | Terminal |
| `mod+w` | `terminalFocus && !stageFocus && isDesktop` | `terminal.close` | Close the terminal | Terminal |
| `mod+]` / `mod+[` | `terminalFocus && !stageFocus` | `terminal.focusNext` / `focusPrevious` | Next or previous pane | Terminal |
| `mod+d` | `!terminalFocus` | `review.toggle` | Open or close the review | Review |
| `mod+shift+d` | | `review.open` | Open the review | Review |
| `mod+shift+r` | | `review.reviews.open` | Reviews | Review |
| `mod+shift+j` | | `preview.toggle` | Preview panel | Preview |
| `mod+shift+b` | | `preview.open` | Open the preview panel | Preview |
| `mod+l` | `previewFocus` | `preview.focus-url` | Preview address | Preview |
| `mod+p` | | `search.files` | Go to file | Search |
| `mod+shift+f` | | `search.content` | Search in project | Search |
| `mod+s` | `editorFocus` | `files.save` | Save the file | Files |
| `mod+s` | `!terminalFocus` | `prompt-tools.stash` | Stash the draft | Prompt Tools |
| `mod+shift+[` / `mod+shift+]` | | `thread.prev` / `thread.next` | Previous or next thread | Thread Rail |
| `mod+alt+arrowup` / `mod+alt+arrowdown` | | `thread.prev` / `thread.next` | Previous or next thread | Thread Rail |
| `mod+1` … `mod+9` | `!modelPickerOpen && isDesktop` | `thread.jump-1` … `thread.jump-9` | Thread 1–9 of the rail | Thread Rail |
| `mod+shift+p` | | `thread.pin` | Pin or unpin | Thread Rail |
| `mod+shift+s` | | `thread.settle` | Settle or un-settle | Thread Rail |
| `mod+z` | `!terminalFocus && !editableFocus` | `thread.undo` | Undo the last unpin, settle, snooze, archive or delete | Thread Rail |
| `mod+o` | | `workspace.open-in-editor` | Open in the external editor | Workspace |
| `mod+alt+e` | | `workspace.files` | Files on the stage | Workspace |
| `mod+alt+p` | | `workspace.open-project` | Open a project | Workspace |
| `mod+alt+j` | | `workspace.open-terminal` | Open in the external terminal | Workspace |
| `mod+e` | | `workspace.open-prompt-editor` | Prompt in the external editor | Workspace |
| `mod+alt+a` | | `appearance.open` | Appearance settings | Appearance |
| `mod+alt+shift+t` | | `appearance.toggle-theme-editor` | Theme editor | Appearance |
| `mod+alt+o` | | `observatory.open` | Signals (Settings) | Signals |

## In a browser tab

A browser keeps some chords for its own tabs and windows and never hands them to
the page: ⌘W, ⌘N, ⇧⌘N, ⇧⌘T and Ctrl+Tab; ⌘1–⌘9 switch its tabs, and Tau leaves
them to it. A binding that pressed one of them would show in a tooltip and close
the tab Tau runs in, so the defaults above carry `isDesktop` and a tab (the web
client, a tablet or a phone with a keyboard) binds these instead, with `!isDesktop`
(VS Code's web build uses ⌥⌘W to close an editor for the same reason):

| Desktop | Browser tab | Command |
| --- | --- | --- |
| `mod+w` | `mod+alt+w` | `workbench.close-stage-tab` |
| `mod+shift+t` | `mod+alt+shift+w` | `workbench.reopen-stage-tab` |
| `mod+n`, `mod+shift+n` | `mod+alt+n` | `runtime.new-session` |
| `mod+n` in a terminal | `mod+alt+n` in a terminal | `terminal.new` |
| `mod+w` in a terminal | `mod+alt+w` in a terminal | `terminal.close` |
| `ctrl+tab` / `ctrl+shift+tab` | `mod+alt+]` / `mod+alt+[` | `workbench.next-stage-tab` / `prev-stage-tab` |
| `mod+1` … `mod+9` | none (the browser's tab switching stays) | `thread.jump-1` … `thread.jump-9` |

A chord that cannot hold on the client is not bound there: Settings →
Keybindings, the tooltips and the conflict check list the chords that work on
this client, and the commands stay in the palette. `mod+shift+[` and `mod+shift+]`
(`thread.prev` / `thread.next`) are tab switching on a Mac's browsers too; Thread
Rail's `mod+alt+arrowup` / `arrowdown` do the same there. Every other default
(`mod+f`, `mod+k`, `mod+d`, `mod+p`, `mod+s`, …) is a chord a page may take
before the browser, and keeps its place.

Inside the model picker, `mod+1` … `mod+9` choose a numbered model and
`mod+shift+arrowup` / `arrowdown` move between providers; the
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

`mod+f` opens the find bar over the transcript wherever the keyboard is except
in a terminal, the preview, Files Kit's editor (CodeMirror's search) and under
an open overlay, which have a find or a keyboard of their own; a second press
moves the keyboard back into the bar. `/` does the same with the keyboard in
the transcript itself. It is `thread.find`, so the page can rebind it.

Inside Settings, `mod+f` and `/` focus the settings search (`mod+f` also from
another field, never from a chord recorder), and Escape clears it first.

A focused terminal answers a few navigation chords itself, ahead of the
window's: on macOS ⌘A selects everything, including the scrollback, and ⌘Home /
⌘End (also with ⇧) jump to its start and to the latest output; elsewhere the same
three are Ctrl+Shift+A, Ctrl+Shift+Home and Ctrl+Shift+End, because Ctrl+A,
Ctrl+Home and Ctrl+End belong to the shell. Shift+PageUp / PageDown page through
the scrollback. A full-screen program (an editor, `less`) keeps Home and End.
The terminal's right-click menu has the same two as "Select all" and "Jump to
latest", beside Copy and Paste.

## Notes on the defaults

- Global chords carry `!terminalFocus` only where the terminal gives the chord
  its own meaning (`mod+n`, `mod+d`, `mod+w`) and for the stash. A shell keeps
  every key it handles anyway, and on macOS the ⌘ chords reach the workbench
  from a terminal, so `mod+k` opens the palette there.
- On the stage a terminal fills its tab: `mod+w` closes the tab, and the split
  and pane chords are not bound there.
- `mod+shift+[`/`]` navigate threads, so stage tabs use `ctrl+tab`; `mod+1`
  … `mod+9` jump to threads, so the focus chords are `mod+alt+1`–`mod+alt+3`.
- `mod+r` and the zoom chords under `previewFocus` are not bound: while the
  preview's page has the keyboard, Preview Kit takes ⌘R, ⇧⌘R, ⌘+ (⌘=), ⌘− and
  ⌘0 in the page's `before-input-event` and reloads or zooms the page, not the
  workbench (the `preview.refresh` and zoom commands, also in the palette
  without chords). The app menu (`src/main/app-menu.ts`) owns ⌘R and ⌘⇧R
  (reload), ⌘0, ⌘=
  (and ⌘+) and ⌘− (the workbench's own zoom, whichever view has the keyboard),
  ⇧⌘V (Paste as Text: the next paste lands as plain text, not as a folded
  file or a chip) and ⌘Q (hold it, or press it twice; Settings → General →
  Quitting). ⌘, is Settings on both sides. `APP_MENU_CHORDS` in
  `src/shared/window-shell.ts` lists them and `kits/kit-lifecycle.test.tsx`
  keeps every other binding off them. A view that wants the zoom chords for its
  own page (a preview) takes them in that view's `before-input-event` and calls
  `preventDefault`, which also keeps the menu's accelerator from firing.
- ⌘N and ⇧⌘N open a new thread in the project on screen; ⇧⌘O and the
  palette's "New thread in…" ask for the project first.
- `rightPanel.toggleMaximized` takes `mod+alt+shift+b`, the dock's chord with
  Shift. It opens the panel in front as a stage tab beside the chat, or moves
  it back.
- `composer.mode` opens Access Kit's menu, since a runtime's mode is Tau's
  access level; the access chip before the model, shown at every level, opens
  the same menu. Plan mode is Plan Kit's `plan.toggle` on ⇧Tab, as in T3 Code,
  but only with the caret in the prompt: in a form, a dialog, a menu, a
  terminal, the Files editor or on a footer button ⇧Tab still moves focus
  back. The thinking level has no default chord (`runtime.cycle-thinking` is
  in the palette); ⌘⇧E opens its menu. A `keybindings.json` that binds Pi's
  `app.thinking.cycle` to `shift+tab` gives ⇧Tab back to the thinking level,
  everywhere: the file wins over the default.
- `composer.*` commands click the composer control that carries their id in
  `data-composer-shortcut`; a control another kit draws can answer the same way.
  The attribute is a space-separated list, matched with `~=`: when a narrow
  composer moves controls into its overflow menu, the menu's trigger carries
  the ids of the controls inside, so the chord opens that menu instead.
- Inside the composer ⌘⇧↵ sends the oldest queued message whatever the send
  setting, and leaves the draft where it is. "Switch
  project…" has no chord: the palette finds projects.
