---
status: accepted
---

# Embed Pi behind a desktop host

Tau will embed the supported Pi SDK in a host process and expose typed commands and events to desktop clients. Pi remains responsible for agent execution, models, tools, skills, sessions, and Pi extensions. The workbench renders that state and sends user intent back to the host.

We rejected reimplementing the agent runtime because it would duplicate Pi and split its ecosystem. We also rejected coupling the renderer directly to Pi internals because it would make remote clients, renderer replacement, and host isolation expensive later.

The initial adapter is an Electron main process using `AgentSessionRuntime` to own the active `AgentSession`, cwd-bound services, extension lifecycle, and session replacement. A future remote adapter may implement the same host semantics over a network transport. This choice adds a messaging layer and requires explicit UI bridges for Pi interactions, but it keeps runtime authority in one place and lets desktop, web, and mobile clients evolve independently.
