# Tau vision

## The idea

Tau is an extensible desktop workbench for coding agents. The shorthand is "Neovim for coding agents": a small, dependable core with a rich product assembled from extensions.

Pi is the agent runtime. Tau does not replace Pi, hide it behind a weaker abstraction, or reimplement its model and tool loop. Tau gives Pi a native, graphical workbench and lets extensions add project management, files, Git, observability, settings, tool presentation, and future workflows.

The Electron application is in alpha: it works for daily use, and its settings, interface and extension API can still change between releases.

## What Tau should feel like

Tau should make long-running agent work easy to navigate without turning the agent into a chat widget.

A user should be able to:

- move between projects and threads quickly
- understand what the agent is doing while it runs
- inspect files, diffs, tools, queues, and runtime state without leaving the workbench
- drive common operations from the keyboard
- install, remove, and configure features without changing Tau core
- keep using existing Pi models, credentials, skills, tools, sessions, and extensions

We adapt useful interaction patterns from other agent workbenches, editors, terminals, and command palettes. Tau should develop its own product language rather than copy another application's source or visual identity.

## Product principles

### Pi remains the runtime

Pi owns agent execution, model selection, tool calls, session persistence, skills, and Pi extensions. Tau consumes Pi through its supported SDK rather than maintaining a fork.

### Core owns placement, extensions own features

Tau core owns the desktop window, layout slots, extension lifecycle, host communication, and shared interaction rules. A feature belongs in an extension when Tau can remain coherent without it.

The current Workspace Kit demonstrates this rule. It contributes project navigation, project sources, file browsing, Git changes, commands, and tool renderers. The left and right docks only provide places for those contributions.

### Keyboard-first, not keyboard-only

Every frequent action should have a direct keyboard path. Mouse and touch interactions still need to be clear and complete. Native modals and pickers are appropriate when the operating system already provides the safer or more familiar interaction.

### Local first, transport ready

The first useful product runs Pi locally and works with local repositories. The host and renderer remain separate so a later client can connect to a remote Pi host without rewriting every feature.

Remote access and mobile rendering are later phases. They should influence interfaces now, but they should not delay validation of the local desktop experience.

### Extensions are real product modules

Extensions are not decorative widgets. They may contribute navigation, project sources, panels, commands, tool renderers, and eventually complete workflows. Deactivating an extension should remove its behavior without edits to core.

### Agent activity stays inspectable

Streaming text alone is not enough. Tool calls, thinking, queues, errors, state changes, and resulting file changes need stable, inspectable representations.

### Prove seams before hardening them

Tau answers architecture and interaction questions with working code. Dynamic loading, permissions, isolation, packaging, and compatibility guarantees come after the contribution model survives real use.

## What belongs in core

Core should stay small and relatively featureless. Its expected responsibilities are:

- start and supervise the desktop host
- connect a renderer to a Pi host through typed messages
- provide layout slots and shared modal infrastructure
- activate and deactivate desktop extensions
- route commands, events, focus, and notifications
- enforce extension permissions and isolation once third-party loading exists
- preserve enough state to restore the workbench

Project management, Git, file trees, runtime settings, tool-specific UI, source control providers, and similar workflows should be extension-owned.

## Two extension domains

Pi extensions change agent behavior inside the host. Desktop extensions change the workbench presented to the user. These are different execution environments and should remain separate interfaces.

A future package may contain both contributions. For example, a review package could add Pi tools and instructions in the host while also adding a review panel and commands in the desktop client. Packaging them together should not collapse the runtime seam between them.

## Product direction

Tau becomes useful when the workbench is better than a collection of chat tabs while Pi remains fully recognizable underneath it. The test is practical: features should be removable, replaceable, and composable, while an active agent session remains reliable and understandable.
