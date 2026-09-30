# Devices

An optional kit for iOS simulators and Android emulators. Open Devices from the stage toolbar or command palette. Refresh a configured host, select a device, then boot it or view its screen. Each selected device has a tab. The same controls work in the web workbench and phone sheet.

The live viewer sends fresh PNG captures through authenticated Tau host commands. It polls serially while visible, so it never creates an unbounded capture queue. Touch coordinates use the image's native pixel dimensions. Tau reads the iOS simulator's screen scale before input and converts pixels to logical points; it refuses input if that scale cannot be read. Dragging sends a swipe. Home, Android Back, orientation and text input use agent-device. Open the app by its identifier before sending input or requesting accessibility snapshots.

Float over chat keeps a draggable screen above the composer while working in a thread. Open controls returns to the stage. The 3D view is a small lazy-loaded CSS perspective shell with turn, tilt and zoom. It displays actual captures, and it does not pretend to expose depth data or additional foldable panels. Device orientation and Android fold posture are real upstream device operations. Unsupported platform controls stay out of the UI; a non-foldable Android emulator reports the upstream fold error.

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

The pinned toolchain and hub route contracts were checked against [T3 Code v0.0.44 DeviceToolchain](https://github.com/pingdotgg/t3code/blob/v0.0.44/apps/server/src/device/DeviceToolchain.ts), [DeviceService](https://github.com/pingdotgg/t3code/blob/v0.0.44/apps/server/src/device/DeviceService.ts) and [DeviceActions](https://github.com/pingdotgg/t3code/blob/v0.0.44/apps/server/src/device/DeviceActions.ts). Input shapes were checked with the pinned [agent-device](https://github.com/callstack/agent-device) CLI help. Platform runner behavior remains upstream's responsibility.

Tests use a loopback fake hub and injected native runner. They cover real process startup, discovery, capture, boot/shutdown transport, settings validation, platform routing, consent, private install completion and failure, SSH quoting, component data readiness and visible failure states. They never boot a simulator or emulator. Real-device verification requires an isolated Tau instance and explicit coordination by the task owner.
