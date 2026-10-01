# Devices

An optional kit for iOS simulators and Android emulators. Open Devices from the stage toolbar or command palette. Refresh a configured host, select a device, then boot it or view its screen. Each selected device has a tab. The same controls work in the web workbench and phone sheet.

The live viewer decodes the hub's H.264 video with WebCodecs. iOS uses the native AVCC HTTP stream; Android uses its SEMU WebSocket stream. Tau keeps both upstream connections on the host and carries bounded video batches through authenticated host commands. A lease belongs to its paired device or local owner, holds at most 4 MiB of queued packets, permits one pending read, and expires after 15 seconds without reads. No hub URL or shell route reaches the client. Hidden, paused and closed viewers release their streams. Unsupported decoders, unavailable streams and slow viewers show serial PNG screen captures instead.

Touch coordinates use the screen's native pixel dimensions, for video and PNGs. Tau reads the iOS simulator's screen scale before input and converts pixels to logical points; it refuses input if that scale cannot be read. Dragging sends a swipe. Home, Android Back, orientation and text input use agent-device. Open the app by its identifier before sending input or requesting accessibility snapshots.

Float over chat keeps a draggable screen above the composer while working in a thread. Open controls returns to the stage. The lazy-loaded 3D view builds solid CSS bodies with front, back and edge faces. Named phone and tablet families get a generic body; names identifying book foldables, clamshells or dual-screen devices get two panels joined at a hinge. The view preserves native screenshot pixels by dividing the capture between the interior panels. Drag to orbit, scroll to zoom, or use the turn, tilt and zoom sliders. Flat screen keeps its native touch and swipe input.

Android fold controls appear only when the upstream hinge sensor reports support. Tau reads and validates its current posture and hinge angle rather than treating the last requested posture as device state. A successful native fold action refreshes the capture even when Live screen is paused. The 3D panels animate to the reported angle; Preview hinge changes only the visual inspection. An unnamed foldable has a user-selectable generic layout because the upstream device list supplies no display topology.

These are family shapes, not measured hardware meshes. Frames and backs use Tau's theme tokens; camera layouts, body measurements and external displays are not inferred from arbitrary device names. At closure, the viewer hides the interior capture. Only a changed aspect ratio relative to a previously confirmed interior capture permits mapping the new capture onto a generic cover display. Unknown, unchanged, tent and rear-display captures remain available in Flat screen. A device first opened in its closed posture has no confirmed interior dimensions; opening it establishes them. The viewer also accepts a decoded video canvas and crops its pixels into the same panels without changing input coordinates.

## Tool installation

Settings → Devices installs `expo-device-hub@0.12.0` and `agent-device@0.21.12` privately under this kit's state directory. These are the tested versions used by T3 Code v0.0.44. No global npm installation is used. Install publishes its completion marker only after npm succeeds and the expected entry exists. Concurrent installation requests share one install. Check tool versions reads the npm registry and reports the latest release without silently changing the supported driver contract. Install repairs a missing supported version; a kit release updates the pins together with its API integration.

Prerequisites on every device host:

- Node.js 22.12 or newer and npm. Set absolute executable paths in Settings when a desktop launch cannot find them. Remote hosts use `node` and `npm` in their noninteractive SSH PATH.
- iOS needs macOS, Xcode, command-line tools and an installed Simulator runtime. This kit does not download Xcode or runtimes.
- Android needs its SDK tools, `adb`, the emulator, an installed system image and an existing AVD. This kit does not accept SDK licenses or create an AVD.
- Input automation can require the upstream runner's platform setup. Errors from that runner appear in the device view.

Dependencies remain in their original npm package trees with their license notices. Tau does not copy upstream implementation code into this kit.

## Remote hosts and access

Add an SSH config alias or `user@host` and an absolute remote tool directory. Save before installing. Key-based, noninteractive login and a previously trusted host key are required. Tau never disables host-key checking. The hub binds loopback on the remote machine and reaches Tau through an SSH local forward. Neither the hub dashboard nor its shell-execution routes are exposed to workbench clients. The kit owns the hub child and closes it on deactivation. Input uses a kit-specific agent-device state directory; the kit stops its own daemon and owned runners when deactivated.

Configure and Install are host-owner commands. Read-only paired devices can discover and view screens, while control requires Full access. A remote phone can therefore watch and, when paired with Full access, send the same device input. Settings writes remain owner-only.

Agent control starts off. The owner must save explicit consent in Settings → Devices before any `device_list`, `device_screenshot` or `device_control` tool can run. Every invocation rechecks that setting. Both Pi and other runtimes through Tau MCP receive the same tools. Agent calls cannot install software or change consent. Device actions serialize per host/device to keep simultaneous user and agent input ordered.

## Platform settings

Both platforms support light/dark appearance, four text-size presets, explicit coordinates for location, and grant/revoke for camera, microphone, location, contacts and calendar on a supplied app identifier. Android cannot clear its last location; set another location instead. iOS supports clearing location and contrast, motion, transparency and VoiceOver controls through the upstream accessibility helper. Android motion controls change its animation scales. Fold posture is Android only and requires a compatible emulator.

## Sources and verification

The pinned toolchain and hub route contracts were checked against [T3 Code v0.0.44 DeviceToolchain](https://github.com/pingdotgg/t3code/blob/v0.0.44/apps/server/src/device/DeviceToolchain.ts), [DeviceService](https://github.com/pingdotgg/t3code/blob/v0.0.44/apps/server/src/device/DeviceService.ts) and [DeviceActions](https://github.com/pingdotgg/t3code/blob/v0.0.44/apps/server/src/device/DeviceActions.ts). The 3D and folding behavior was checked against [T3's device viewer PR 12787](https://github.com/pingdotgg/t3code/pull/12787), [fold controls PR 13534](https://github.com/pingdotgg/t3code/pull/13534), and the fold GET/POST handlers and native sensor reader shipped in [expo-device-hub 0.12.0](https://www.npmjs.com/package/expo-device-hub/v/0.12.0). The hub discovery contract supplies names and platform information, not body meshes or display topology. Input shapes were checked with the pinned [agent-device](https://github.com/callstack/agent-device) CLI help. Platform runner behavior remains upstream's responsibility.

Tests use a loopback fake hub and injected native runner. They cover real process startup, discovery, capture, boot/shutdown transport, settings validation, platform routing, consent, private install completion and failure, SSH quoting, component data readiness and visible failure states. Model and rendering tests cover hinge pivots, disjoint screenshot regions, real depth faces, closed capture mapping, orbit/zoom/reset, confirmed native posture and unsupported fold controls. They never boot a simulator or emulator. Real-device verification requires an isolated Tau instance and explicit coordination by the task owner.

Video tests exercise fragmented AVCC envelopes, actual loopback SEMU WebSocket packets, caller isolation, lease expiry, concurrent-read refusal and bounded queues. The wire formats are documented by the pinned [T3 stream client](https://github.com/pingdotgg/t3code/blob/v0.0.44/packages/client-runtime/src/device/stream.ts). T3's [updateTool handler](https://github.com/pingdotgg/t3code/blob/v0.0.44/apps/server/src/device/DeviceService.ts) installs its pinned supported version too. An update to the registry's newest tool is therefore not a missing parity feature.
