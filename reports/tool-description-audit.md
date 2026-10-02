# Tool description audit

## Applied in this branch

The 34 Tau-owned descriptions in Preview, Agents, Evidence, Takeover, Review and Servers now lead with their purpose. Their `promptSnippet` text follows the same wording. Names, execution code and accepted arguments are unchanged. Parameter descriptions retain mode-specific details; destructive effects, access requirements and approval boundaries remain explicit.

The PR-linking policy remains in `LINKING_INSTRUCTIONS`, which reaches every runtime, rather than being repeated in list-tool descriptions.

On the original audit branch, the pre-existing kits typecheck failure was a separate access bug: `kits/workspace/desktop.tsx` queried `isReadOnly` on the extension command client, where that method does not exist. That branch's fix uses `useHostCapabilities`, with a regression test covering read-only and writable host clients. The current main branch has already removed that region registration, so the tool-description PR does not carry this obsolete fix.

## Tools owned elsewhere

These findings describe local source and installed packages, not a fresh upstream survey. No installed package, user configuration or other worktree was modified.

### Devices

The exact three descriptions exposed in this conversation are present in `kits/devices/host.ts` in the sibling `tau-public-worktrees/parity-device-hub` checkout, inspected at `8fd5f804`. The original audit branch had no Devices Kit; current main does. This establishes a matching source, not proof of which installation supplied the running session.

Suggested descriptions for a separate Devices Kit follow-up:

- `device_list`: "Find available iOS simulators and Android emulators for app testing. Requires agent device consent."
- `device_screenshot`: "Inspect visual layout and rendering on a booted device. Requires agent device consent."
- `device_control`: "Test app interaction, accessibility and behavior under device settings. Can change permissions or shut down a device. Requires agent device consent."

Before shortening `device_control`, move the existing action prerequisites and platform restrictions to parameter descriptions. In particular, preserve the requirement to open an app before snapshot/input, image-pixel coordinates, Android-only back/fold, iOS-only clearLocation, foldable-device requirements and the allowed values for settings. Its required `hostId` currently says "local by default"; resolve that schema/documentation mismatch separately rather than promising a default the schema does not supply.

### Pi built-in tools

Inspected `@earendil-works/pi-coding-agent` 0.85.1, `dist/core/tools/{read,bash,edit,write}.js`. These descriptions belong to Pi, not Tau's kits. Suggested purpose-first wording for an upstream change:

- `read`: "Inspect existing source, documents or images. Large text results are truncated; read remaining portions before relying on the whole file."
- `bash`: "Run project commands, tests, searches and filesystem operations. Commands can change files and system state."
- `edit`: "Make targeted changes to an existing file while preserving surrounding content. Replacements must match unique, non-overlapping text in the original file."
- `write`: "Create a file or replace its entire contents. Overwrites existing files."

Keep numeric output limits, timeout behavior and replacement semantics in the appropriate argument/result documentation. Do not shadow these tools in Tau merely to change wording: other runtimes own different native tool contracts.

### Pi Subagents

Inspected installed `pi-subagents` 0.71.0, `src/extension/tool-description.js` and `src/runs/background/wait-tool.js`.

- `subagent` combines delegation, orchestration and management. A useful first sentence would be "Delegate authorized work to agents or manage existing agent runs."
- `bg_wait` already distinguishes its purpose from native completion notifications. A concise lead would be "Wait for background work that cannot notify this session when it finishes."
- The package supports custom descriptions but always appends mandatory safety guidance. Its compact mode also retains the main execution guidance. Switching modes would not produce a genuinely short tool contract.
- Move advanced workflow syntax into the existing guides upstream, while retaining delegation authorization, writer isolation, failure recovery and notification rules. Do not suppress those rules through a Tau override.

### Computer Use

Inspected installed `@amaster.ai/pi-computer-use` 0.1.18, `dist/index.js`. Its `registerTools` function forwards `tool.description` and `tool.inputSchema` from the native driver. Changes to most descriptions therefore belong in the driver, not in Tau or the npm bridge.

Suggested purpose-first leads for the core tools:

- App discovery/launch: find or open the application being tested.
- Window state: inspect current UI content and locate action targets.
- Verification: confirm a specific UI postcondition instead of assuming input succeeded.
- Click/type/key tools: test pointer, text and keyboard interaction.
- Drag/scroll: test repositioning and reach content outside the visible area.
- Value setting: change native controls such as sliders and dropdowns.
- Zoom: inspect a small visual detail.

Retain exact-window targeting, snapshot freshness, coordinate frames, input-delivery limits and password/consent restrictions. These are correctness and safety requirements, not removable wording overhead. Keep optional groups lazy-loaded. A local replacement description risks hiding platform-specific driver limitations.

## Validation on the original audit branch

- Full `npm run typecheck` passed after the workspace access fix.
- The workspace access regression failed before the fix, rendering `writable` for a read-only host, and passes after it.
- Targeted kit tests cover Preview, Agents, Evidence, Takeover, Review and Servers.
- Tests use the existing sibling checkout's dependencies through a temporary symlink. A temporary Vitest config permits that dependency path for SVG imports in component tests; neither file is retained.

No external package release, Devices Kit integration or live model-selection evaluation is claimed by this change.
