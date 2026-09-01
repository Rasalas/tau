# Lessons from OpenCode's diff viewers

Inspected on 2026-09-01 against OpenCode's `dev` branch and the locally installed OpenCode 1.18.20 UI.

OpenCode has two deliberate review layouts:

- The desktop v2 review is detail-first: a resizable file tree and one active file.
- The TUI starts with all patches in one stream and can switch to a single patch.

Tau is a desktop app, so its default follows the desktop v2 layout. A continuous all-file stream should only be added with variable-height virtualization and lazy patch loading; eagerly loading every patch repeats a failure OpenCode has already seen on large workspaces.

## What OpenCode gets right

| Lesson | Evidence in OpenCode | Consequence for Tau |
| --- | --- | --- |
| A review is a workspace, not a small preview panel. | The desktop review owns a sidebar, toolbar, file header, diff surface, comments, and empty states. | Keep review in its own page and preserve branch/worktree scope, notes, and viewed state. |
| A path hierarchy is faster to scan than a flat list. | Both viewers build a directory-first tree; the TUI also compresses single-child directory chains. | Use an expandable changed-file tree with status and line statistics. |
| Search is temporary navigation state. | Desktop v2 deliberately does not persist its file filter because a stale filter can silently hide changes. | Add a transient path filter and clear affordance; never store it with review state. |
| The sidebar is optional working space. | Desktop v2 persists open state and width, supports 200–480 px resizing, and moves file metadata into the toolbar when hidden. | Make Tau's tree resizable and collapsible, while keeping file position and navigation visible. |
| File-to-file navigation must be immediate. | Desktop v2 provides previous/next buttons and left/right shortcuts; the TUI adds next/previous file and hunk commands. | Add buttons and keyboard cycling, disabled while typing in inputs or comments. |
| The active file needs a stable identity header. | Status, file icon, basename, muted directory, additions, and deletions sit directly above the diff. | Do not use the full path as an undifferentiated toolbar label. |
| Dense context is opt-in. | Desktop v2 defaults to collapsed unchanged lines and offers an explicit expand control. | Default to three context lines and offer “All lines” as a bounded reload. |
| Layout should degrade deliberately. | TUI forces unified mode when the patch pane is narrower than 100 columns. | Tau automatically falls back to unified layout on narrow windows and hides the tree at the small-screen breakpoint. |
| Review state is semantic, not merely decorative. | TUI tracks reviewed files and mutes their path, stats, and diff colors together. | Keep explicit viewed toggles and mute the complete file row without removing status. |
| Diff semantics outrank syntax decoration. | OpenCode has an open bug where syntax highlighting overrides added/removed/context foreground colors. | Tau keeps addition/removal foreground and background colors on the final diff cells. Syntax highlighting must never overwrite them. |
| Large diffs require two limits. | Desktop v2 virtualizes files above 500 lines. OpenCode also has reports of full-file rendering and `/vcs/diff` exhausting memory in umbrella workspaces. | Keep row virtualization, per-file loading, hunk pagination, byte/line ceilings, and bounded explicit context. Never fetch every branch patch just because the tree opened. |
| Loading and failure states belong in the design. | OpenCode renders separate loading, empty, error, binary/no-patch states. | Tau distinguishes loading, load failure, no textual diff, and host truncation. |

## Failures worth retaining as guardrails

1. Removing context stripping made the desktop Git Changes surface render whole files instead of changed regions ([OpenCode #29768](https://github.com/anomalyco/opencode/issues/29768)). “Show all lines” therefore stays explicit and host-bounded.
2. Eager VCS diff work across umbrella workspaces can exhaust memory ([OpenCode #24049](https://github.com/anomalyco/opencode/issues/24049)). Opening a review must load the list and active patch, not every patch.
3. Syntax tokens can accidentally erase diff foreground semantics ([OpenCode #32016](https://github.com/anomalyco/opencode/issues/32016)). Added/removed/context colors remain the final styling layer.

## Source map

- [Desktop v2 review panel](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/pages/session/v2/review-panel-v2.tsx)
- [Desktop v2 review layout](https://github.com/anomalyco/opencode/blob/dev/packages/session-ui/src/v2/components/session-review-v2.tsx)
- [Desktop v2 file preview and comments](https://github.com/anomalyco/opencode/blob/dev/packages/session-ui/src/v2/components/session-review-file-preview-v2.tsx)
- [Desktop v2 virtualization threshold](https://github.com/anomalyco/opencode/blob/dev/packages/session-ui/src/v2/components/session-review-file-preview-v2-virtualize.ts)
- [TUI diff viewer](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/feature-plugins/system/diff-viewer.tsx)
- [TUI file-tree model](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/feature-plugins/system/diff-viewer-file-tree-utils.ts)
