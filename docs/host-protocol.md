# Host protocol (v1)

The typed host boundary uses `version: 1` focused updates. A client may ignore a
message with an unknown version or type and continue using its last coherent
state; it must not reinterpret it as a `HostSnapshot`.

- `thread-index` and `thread-shell` contain navigation records only.
- `thread-detail` contains the active session's messages, run state, tools, and usage.
- `transcript-page` contains a bounded page plus a cursor for older records.
- `catalog` contains models, thinking levels, tools, and extension count.
- `project` contains workspace identity, branch, and optional project metadata.
- `run` contains lifecycle state for the active session.

The legacy `HostSnapshot` remains a recovery shape for pre-v1 clients only. New
bootstrap responses provide `version`, detail, catalog, project metadata, and the
thread index separately; normal metadata actions return focused updates.
