# Computer Use

This kit owns desktop tool sessions in the Tau host. Pi registers the tools
through a runtime extension; other runtimes get them through Tau's existing
thread-scoped MCP endpoint. Both paths use the same driver, action policy and
screen feed. MCP does not construct a Pi extension context.

The native implementation remains `CuaDriverClient`, a public export of
`@amaster.ai/pi-computer-use`. Tau loads the installed package through
`services.loadDependency` so the driver's bundled binaries remain discoverable.
The dependency is pinned (0.1.24, Cua Driver 0.34.0, shipped as a platform
package beside it) because macOS tool discovery reads its generated manifest. Other platforms query their native driver for the actual tool schema.

## Native tools take precedence

A runtime can report `nativeCapabilities: ["computer-use"]` when connecting to
Tau MCP. The endpoint binds that information to its thread credential and the
kit omits its fallback tools for that runtime. Codex checks its enabled native
plugin and installed executables before reporting this capability. Merely
selecting an OpenAI model does not disable Tau's tools.

## Configuration and approvals

The existing `pi-computer-use` configuration remains supported. Project-local
settings apply only to trusted projects. Launch approvals are remembered per
thread and target; dangerous operations retain their confirmation, which
includes reading or writing the clipboard and installing a driver extension. Recording
always requires confirmation and an output directory within the thread's
workspace, including after resolving symbolic links. macOS Accessibility and
Screen Recording permissions still belong to the operating system.

If the user lists `npm:@amaster.ai/pi-computer-use` in Pi's `packages`, Tau's
Pi runtimes do not load it (`replacesPiPackage`, API 1.59.0) and use the
kit's registration of the same package instead. The kit pins the version it
tests, and that registration is deferred, so the tools stay out of every
request until `tool_search` finds them; the package registers them directly,
which is about 12,800 more input tokens on each request. The `pi-computer-use`
configuration block still applies. Pi's settings files and a Pi terminal are
not touched. A listing that is not this npm source (a local path, a git URL)
loads as the user wrote it, and the screen observer watches its results. The
optional configured vision-model analysis helper remains available on Pi; MCP
tools return image content directly to the calling runtime.

Closing a thread cancels its driver work and closes its native client. The
screen view uses the same session for user input and brings forward only the
window identified by that thread's tool results.
