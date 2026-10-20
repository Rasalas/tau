# ADR 0037: Device file reads stay inside admitted workspaces

## Amendment, 2026-10-20: Full access includes file reads

The path restrictions below now apply to Read-only devices. A device paired
with Full access may read outside the workspace, hidden Home entries and Git
internals. It already has authority to execute commands there; applying a
stricter rule to its Files, Search and project metadata reads made remote
worktrees under `~/.tau` unusable without adding a meaningful boundary.

Full file access does not make a device the owner. Connection management,
access-key management and other owner-only operations still require the local
owner connection. Host command handlers receive `fullAccess: true` separately
from `owner`; older hosts without that field retain the stricter behavior.
Read-only devices keep the canonical-path, workspace and symlink checks below.

## Status

Accepted, 2026-10-12. Amends ADR 0024's promise that Read-only devices see
every file the workbench shows.

## Decision

A non-owner's `access: "read"` kit command may name files inside an admitted
workspace, including project dotfiles such as `.github/workflows/ci.yml`,
`.gitignore`, `.env.example` and `.tau/project.json`. This also applies to Full
devices and host tokens used beyond the owner's local connection. Absolute
paths, relative paths and symlinks cannot cross that workspace boundary.

Canonical paths under any hidden entry directly in the host's home directory
are forbidden, including the entry itself. The rule covers every `~/.<name>`
and its descendants, even when Home is an admitted workspace. Git internals
under any `.git` entry are also forbidden. Other hidden entries inside a
workspace remain readable. Authorization uses `realpath` so aliases do not
grant access to a protected canonical target.

The receiving registry checks path arguments before local execution of commands
and jobs. It also checks nested records and arrays. An explicit workspace must
already be admitted. Delegation between in-process host extensions retains the client
principal and the checked working directory for the duration of the call.
An explicit admitted workspace or cwd scope selects that directory; otherwise
the host's current working directory is used.
An active-project switch cannot redirect an in-process read after authorization.
The check covers path fields such as `path`, `relPath`, `paths`,
`filename` and their suffixed forms; ordinary text and search queries are not paths.
A refusal is expected, audited, and does not consume a kit's crash
budget. Folder browsing without a path starts at the workspace for devices.
Remote forwarding checks command authority on the source host; filesystem
paths are authorized by the host that actually reads them.
Search and directory listings apply the same rule. Search rechecks cached
file paths before reading them; a cached filename cannot become an outside
or protected symlink. A device search whose workspace contains Home uses the
walker so protected ignore files are not read. Other device searches disable
global, parent and Git-internal ignore configuration in ripgrep.

The owner may still open absolute and parent-relative transcript links.
Devices cannot use an outside link as authority: command input does not prove
that the transcript contained it. Supporting such links for devices would
require host-established evidence of their origin. Connection-scoped browser
capabilities remain usable as virtual resources; they authorize no existing
filesystem path.

## Consequences

The host token and other secrets outside projects, under hidden Home entries,
or inside Git internals cannot be retrieved through these file arguments.
Project dotfiles stay available to devices; the owner's behavior is unchanged.
The policy checks every read command at its shared dispatch boundary, with a
test inventory drawn from the bundled declarations. Workspace tests also
exercise its real registered commands and preserve owner link behavior.

Installed host extensions remain trusted code, as in ADR 0018 and ADR 0024.
This input policy is not an operating-system sandbox: a handler must still
authorize any filesystem access it derives internally. Concurrent filesystem
changes between authorization and use are not locked by this decision.
