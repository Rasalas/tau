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
- The view is drawn over the panel, so anything the renderer paints on top of that rectangle — a modal, a toast — is covered by the page. Overlays that must win have to hide the preview first; today only a panel switch does.
- A page loaded in the preview is a page the user's browser profile does not know: cookies live in `persist:tau-preview` and outlive a restart. Clearing it is not offered yet.
- The refs are only as fresh as the last snapshot. A tool that acts on a stale ref acts on whatever holds that attribute now, which is why every action reports what it actually touched.
