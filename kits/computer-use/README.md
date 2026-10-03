# Computer Use

This kit owns desktop tool sessions in the Tau host. Pi registers the tools
through a runtime extension; other runtimes get them through Tau's existing
thread-scoped MCP endpoint. Both paths use the same driver, action policy and
screen feed. MCP does not construct a Pi extension context.

The native implementation remains `CuaDriverClient`, a public export of
`@amaster.ai/pi-computer-use`. Tau loads the installed package through
`services.loadDependency` so the driver's bundled binaries remain discoverable.
The dependency is pinned because macOS tool discovery reads its generated
manifest. Other platforms query their native driver for the actual tool schema.

## Native tools take precedence

A runtime can report `nativeCapabilities: ["computer-use"]` when connecting to
Tau MCP. The endpoint binds that information to its thread credential and the
kit omits its fallback tools for that runtime. Codex checks its enabled native
plugin and installed executables before reporting this capability. Merely
selecting an OpenAI model does not disable Tau's tools.

## Configuration and approvals

The existing `pi-computer-use` configuration remains supported. Project-local
settings apply only to trusted projects. Launch approvals are remembered per
thread and target; dangerous operations retain their confirmation. Recording
always requires confirmation and an output directory within the thread's
workspace, including after resolving symbolic links. macOS Accessibility and
Screen Recording permissions still belong to the operating system.

A user-installed Pi Computer Use extension keeps precedence over Tau's Pi
adapter. The screen observer still watches its results. The optional configured
vision-model analysis helper remains available on Pi; MCP tools return image
content directly to the calling runtime.

Closing a thread cancels its driver work and closes its native client. The
screen view uses the same session for user input and brings forward only the
window identified by that thread's tool results.
