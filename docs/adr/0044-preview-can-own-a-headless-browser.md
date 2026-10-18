# Preview can own a browser without a desktop window

Preview uses an owned headless Chromium process when its home machine has no
drawable Tau window, or when `TAU_PREVIEW_BROWSER` explicitly selects that
browser. This supersedes ADR 0012's requirement for a desktop window while
keeping `PreviewSurface`, the host's ownership rules and its existing frame and
input commands. Chromium is controlled over private inherited pipes, uses
Preview's own persistent profiles and retains its sandbox. It never opens the
user's Chrome profile or a network debugging listener.

A desktop window keeps its embedded view by default. Headless pages appear
through the same frames on desktop, web and compact clients. The host requires
an installed Chromium-compatible executable and works without a display or a
runtime browser download. Headless video recording uses Chromium's native CDP encoder on Chrome/Chromium
153+ builds with AV1 recording support. It produces silent MP4 through a private
IO stream, drained incrementally and finalized before close. A live EOF does not
end the recording. Desktop recording keeps its WebM encoder. Neither path needs
a runtime download or external encoder. The host keeps the existing ten-minute
and 500-MB output caps; these do not promise a hard bound on Chromium's internal
encoder queue. Missing native recording support gets a clear capability error.

The user-driven cookie import dialog also works headlessly. Source browsers and
keychain prompts belong to Preview's home machine. Imports serialize with profile
changes, use an owned helper for the selected profile and verify each cookie
through Chromium's root Storage commands. Normal helper shutdown persists the
writes before completion. Owned profiles use `--restore-last-session` together
with `--no-startup-window` to retain session cookies without opening saved pages.
An active page is explicitly reopened on the same headless backend after the
helper exits; an inactive profile import leaves the active page alone. Desktop
imports keep their window-owned store and delayed keychain jobs. Browser login,
retained profiles, screenshots, console errors and explicit downloads also work
headlessly.
