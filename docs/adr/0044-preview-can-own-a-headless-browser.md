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
runtime browser download. Video recording and importing another browser's
cookies still require the desktop implementation; browser login, retained
profiles, screenshots, console errors and explicit downloads work headlessly.
