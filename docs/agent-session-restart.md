# Restart an agent session

The command palette's **Restart agent session** action restarts the idle thread on screen while retaining its Tau thread ID, provider session, runtime backend, conversation, model selection and executing account. It is separate from **Apply changes and reload Tau**, which rebuilds and reloads the workbench.

Supported runtime owners:

- **Pi:** dispose and reopen the same persisted session. Clear the host resource-discovery and model caches before reopening so new skills, runtime extensions and configuration are discovered without reusing the prewarm snapshot.
- **Claude Code:** close this thread's SDK process, reread the workspace skill catalog, and resume its persisted Claude session in a fresh process on the next prompt. The fresh CLI discovers its plugins and MCP configuration; Tau reconnects its own MCP endpoint when opening it.
- **Codex:** close only this thread's app-server, start a fresh one, and strictly resume the same Codex thread. A missing resumed session fails the action rather than replacing the conversation with a new provider thread. Other live threads retain their app-servers.

The host checks the backend's optional `restart` capability. Other runtimes, attached terminal-owned Pi sessions, and threads proxied from another home machine currently refuse the action. A proxy never restarts a local process or switches the remote machine's selected thread. Open the thread directly on its home machine to use the action there.

Running turns, tools, questions, pending messages and Claude background tasks prevent restart. The workbench also refuses when the thread has queued messages. Restart temporarily blocks message admission and thread configuration changes. A prompt prepared before restart is rejected if its runtime generation changes, even when restart finishes before preparation does.

If Pi cannot reopen, its persisted conversation remains visible in a read-only shell with the failure reason. Opening that thread again retries the runtime. A failed external restart retains its backend and conversation so the next prompt can reconnect.

Regression coverage exercises preserved transcripts and provider IDs, a fresh Codex process, changed Claude skills, background-task refusal, pending-message refusal, another thread remaining untouched, stale palette selection, concurrent sends during delayed restart, stale prepared prompts, and recoverable reopen failure.

## Verification on 3 October 2026

An isolated Tau window used its own `.tau-dev/userdata`, workspace, Pi sessions and fake-model agent directory. A real Pi conversation completed before the test. A new `restart-probe` skill was added after the initial catalog had been cached, then **Restart agent session** was clicked in the command palette. The resulting bootstrap retained the same thread/session ID and both original messages, and included `skill:restart-probe`, which was absent beforehand. A second composer message completed successfully in that same thread after restart.

Focused host/backend tests and the split-transport tests verify restart refusal and routing as well as transcript preservation. The Codex process fixture also verifies that restart retains the selected service tier while resuming the same provider thread.
