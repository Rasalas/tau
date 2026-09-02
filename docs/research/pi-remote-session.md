# Pi's remote session against Tau's bridge

Research note, 2026-09-02, for Pi 0.84.4. Decides whether Tau should attach to Pi through Pi's own client instead of `.pi/extensions/tau-session-bridge.ts`.

## What Pi ships

Pi has two headless paths, both separate from the interactive terminal:

- **RPC mode** (`pi --mode rpc`, `docs/rpc.md`): Pi runs as a child process and speaks JSON lines over stdin and stdout. The command set is complete for a client: `prompt` with `streamingBehavior`, `steer`, `follow_up`, images on all three, `abort`, `clear_queue`, model and thinking selection, `compact`, `bash`, `switch_session`, `fork`, `clone`, `get_tree`, `get_entries`, `get_messages`, `get_commands`, `set_session_name`, `export_html`. Extension questions arrive as `extension_ui_request` events (select, confirm, input, editor and more) and the client answers them. `RpcClient` in `dist/modes/rpc/rpc-client` spawns and types this.
- **RemoteSession** (`dist/client/remote-session`, on `@earendil-works/pi-client` and `@earendil-works/pi-protocol`): a state holder over a `PiClient` connection with `open`, `create`, `submit`, `abort`, `setModel`, `setThinking`, `reconnect`, a transcript snapshot and a session list. It has no steer or follow-up, no images, no extension questions, no fork or tree, no transcript paging and no tool output reads. Pi's docs do not mention it; it is experimental.

Neither path attaches to a Pi that is already running in a terminal. Both start or connect to a Pi that has no user of its own.

## What the bridge does that neither path does

Tau's bridge attaches to the Pi terminal the user already has open, with the terminal keeping ownership: Pi answers its own questions, Tau mirrors the transcript and can prompt, steer, abort, fork and page. That is the "attach" use case, and it is the only reason the bridge exists; Tau's own threads run the SDK in process (ADR 0001, ADR 0004).

| Capability | Bridge | RPC mode | RemoteSession |
|---|---|---|---|
| Attach to a running terminal Pi | yes | no | no |
| prompt, abort | yes | yes | yes |
| steer, followUp | yes | yes | no |
| images | yes | yes | no |
| Extension questions (`ctx.ui`) | stay in Pi's terminal, Tau shows "waiting" | answered by the client | no |
| fork, clone, tree | fork | yes | no |
| Transcript paging | yes | `get_messages`, `get_entries` | snapshot only |
| Tool output reads | yes | no | no |
| Host extension commands and events | `extension` command, `extension-event` frames | no | no |

## Recommendation

- Keep the in-process SDK as the core runtime. Nothing here replaces it.
- Keep the bridge only for attaching to a terminal Pi, and freeze it: no new bridge commands or frames. Features reach it through the generic `extension` command and `extension-event` frame (Workspace Kit's checkpoints already do), never through new bridge protocol entries.
- Do not adopt `RemoteSession` now. Revisit when Pi documents `pi-client`, when RemoteSession carries steer, follow-up, images, extension questions and paging, and when a terminal Pi can host such a client. At that point the bridge's socket, snapshot and paging code can go, and only its Tau-specific parts (client message correlation, checkpoint events) would move onto the official transport.
- RPC mode is a different product decision: Tau running Pi as a child process instead of in process. It would isolate crashes and load Pi's extensions exactly as the CLI does, at the price of a process per thread and a JSON hop for every event. Worth a spike when the core is done shrinking, not before.
