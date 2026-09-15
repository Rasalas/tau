# ADR 0020: Host commands use host-established caller authority

The workbench and its desktop extensions share a JavaScript realm and the
same host connection. Retain that trusted-workbench model from ADR 0009 and
ADR 0010. The host authenticates the workbench as one caller; a desktop
extension name in a command request identifies routing, not independent
security authority. Host extension contexts and worker supervisors may assign
extension authority themselves, but request data cannot promote a caller to
another authority.

Electron requests must originate from the current workbench WebContents and
its main frame. Reject other contents, subframes, detached frames and replaced
windows before returning hello state or dispatching a command. Socket callers
must complete the existing token handshake before dispatch. A command failure
or authorization refusal does not authenticate a caller for subsequent calls.

## Consequences

A desktop extension loaded into the trusted workbench can use that workbench's
host commands. Review reading Workspace's changes and file diffs remains
supported, as do Workspace's interactive write commands. Receiver-side service
grants still constrain the host extension handling a request. They must not be
presented as a sandbox for the desktop half or as the union of permissions
required for an unrelated read-only command.

A hostile desktop extension cannot be separated from trusted workbench code
by adding callerId, a JavaScript closure or a token handed to the same realm.
Doing so would require separate execution realms and separately authenticated
channels, changing how React contributions and cross-extension services work.
That is a different product architecture, not the authorization mechanism in
this decision. Worker failure containment likewise remains distinct from an
OS sandbox, as described by ADR 0018.

Host extensions receive an invocation context bound to their activation by the
registry and revoked on deactivation or failed activation. Cross-extension calls
use that bound context; worker supervisors supply it themselves. Target commands
opt in through `registerCommand(..., { callers })`. An extension may call its own
commands and only the foreign commands that name it. Core and authenticated
workbench calls retain access to the host command surface. Background jobs
preserve their originating principal.

Workspace grants Review access to `changes` and `file-diff`. Review's desktop
uses its own host proxies, which invoke Workspace with the Review host context.
Other foreign commands are denied unless their target declares a grant. API
1.6.0 publishes the context method and command policy; Review and Workspace
require that version.

Authorization denials log caller, target, command, capability and reason, return
an expected `unauthorized` error and do not consume the handler crash budget.
Tests exercise real registry dispatch, forged and expired contexts, transport
sender rejection, worker forwarding and job provenance. Detailed evidence is
recorded in `.scratch/architecture-completion/03-command-authorization.md`.
