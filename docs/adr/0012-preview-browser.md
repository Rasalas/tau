# ADR 0012: The preview is a host-owned browser view, not a renderer frame

## Status

Accepted, 2026-09-06.

## Context

An agent that changes a web app cannot tell whether the change worked. It can read files and run a build, but the result — the rendered page, the button that now toggles, the console error — is invisible to it, and to the user it is a second window beside Tau.

The obvious place for a page is the renderer: a `<webview>` or an iframe inside the panel. Neither is available. [ADR 0009](0009-extension-permissions.md) turned the workbench window into a sandbox: `webviewTag: false`, `will-attach-webview` prevented on every `webContents`, a CSP of `script-src 'self' tau-ext:` and a permission handler that denies everything. Loading a project's page into that document would either weaken the workbench's own boundary or run the page under the workbench's CSP, where it is not the page any more.

## Decision

**The preview is a `WebContentsView` the main process owns**, created by the bundled kit `tau.preview` and added to the window's `contentView`. It is a sibling of the renderer, not content inside it: its own `webContents`, its own session partition `persist:tau-preview`, no Node, no device permissions, and `file://` only inside the workspace of the thread that asked (`fileUrlAllowed`, enforced on `webRequest` and on `will-navigate`). Popups are denied and handed to the system browser.

**The panel is a hole, not a container.** The desktop half draws a toolbar and an empty rectangle, and reports that rectangle's CSS-pixel bounds through the host command `preview.bounds` on mount, on `ResizeObserver`, on window resize and scroll, when the user switches to another panel (`visible: false`) and on unmount. The host multiplies by the window's zoom factor (`previewRect`) and calls `setBounds`/`setVisible`. Switching panels hides the view; only `preview.close` destroys it, so the page keeps its state, its scroll position and its history while the user looks at Files.

**Reading beats screenshotting.** `preview_snapshot` injects a self-contained function that walks the DOM and returns a compact role/name tree, marking every actionable element with `data-tau-ref="e1"`, renumbered per snapshot. The model addresses elements by that ref (or a selector, or visible text) in `preview_click`, `preview_type` and `preview_scroll`. `preview_screenshot` exists for layout questions and returns `ImageContent` scaled to 1280 px. Typing goes through the prototype's `value` setter plus a bubbling `input` event, because assigning `.value` is exactly what React ignores.

**Everything Electron sits behind `PreviewSurface`.** The tools, the URL rules and the bounds arithmetic are plain TypeScript against that interface; `preview-view.ts` is the only file that imports Electron, and it is imported dynamically, only when a tool first needs a view. A host without a window — `headless.js`, or a window that is only a client of a remote host — resolves no surface and every tool answers `Preview needs the Tau desktop app on this host`.

## Consequences

- The workbench's sandbox is unchanged: no webview tag returns, and the previewed page never shares an origin, a session or a CSP with the workbench.
- One view per window, one page per view. Tabs, devtools for the previewed page, recording and element picking are not there; T3 Code's preview has them and is thirty times the size.
- The view is drawn over the panel, so anything the renderer paints on top of that rectangle is covered by the page. Two answers, by kind of surface. **A surface that owns the window takes the view off it**: `overlay-watch.ts` watches the document for the scrims those surfaces put up — `.modal-scrim`, `.palette-backdrop`, `.project-picker-scrim`, `.project-modal-scrim`, `.attachment-lightbox`, `.reload-curtain`, and `[data-preview-overlay]` for anything that owns the window without wearing one — and the panel folds that into the same `visible` flag a panel switch uses. One `MutationObserver` for the window, answering once a frame, because a modal can mount anywhere: the checkpoint dialog inside a dock panel, the lightbox portalled to the body. **A transient surface keeps clear instead**: while the view is on screen the panel publishes its rectangle through `reserved-region.ts`, toasts centre on the workbench's centre column rather than the window (`--stage-left` / `--stage-right`), and menus and popovers that would land on that rectangle slide left out of it. Nothing moves while the preview is closed, so a menu behaves as it always did.
- Hiding is about what covers the rectangle, not about attention. Losing focus is not a reason to hide — the page keeps rendering behind another window — and a resize under an open modal re-measures without re-showing, because every bounds report is filtered through the same overlay answer. A panel that remounts while a modal is up starts hidden and comes back on its own when the modal closes, since subscribing tells the new panel the current answer straight away.
- A page loaded in the preview is a page the user's browser profile does not know: cookies live in `persist:tau-preview` and outlive a restart. Clearing it is not offered yet.
- The refs are only as fresh as the last snapshot. A tool that acts on a stale ref acts on whatever holds that attribute now, which is why every action reports what it actually touched.
