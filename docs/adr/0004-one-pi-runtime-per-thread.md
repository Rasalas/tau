---
status: accepted
---

# One Pi runtime per thread

The host keeps a live Pi runtime for every open thread, keyed by session, instead of one runtime that is replaced on every thread switch. Switching threads changes which runtime the workbench shows; it creates, aborts, or replaces nothing. A new thread takes a blank runtime that was prepared for the current project ahead of time, so it is on screen within milliseconds. Idle runtimes beyond a small budget are released oldest first; a runtime with a run in flight, an open extension question, or nothing saved yet is never released.

Every live event names the thread it belongs to, and prompts, steering, and aborts name the thread they target. The renderer applies transcript and tool events only to the thread it is showing and re-reads a thread's state from its runtime when it opens it. Aborting a thread settles that thread's open questions and approvals before asking Pi to stop, because Pi's abort waits for the run to go idle.

The single-runtime design failed in practice: switching away from a thread aborted its run, and a tool blocked on an unanswered extension question held that abort open, which wedged the host's lifecycle queue and every later switch. Extension questions also lost their thread when the runtime behind them was replaced. We rejected keeping one runtime with smarter switching because the failure was structural, not a missing guard. Out-of-process runtimes remain the seam for isolating project extensions; the registry's isolation field is where that lands.

The lifecycle queue that serialises opening, switching, forking and disposing
threads is reentrant (`src/main/lifecycle-queue.ts`). It tracks itself with
`AsyncLocalStorage`: an operation started while the caller already runs inside
a queued one runs inline instead of enqueuing itself. Without that, the failure
above returns through the extension seam — the queue runs the thread lifecycle
hooks, and a hook that asks for `services.sessions.exclusive` would wait for
the operation it is part of, wedging the host for good. The queue also records
the operation holding it and reports one that holds it for more than 30
seconds, without ever aborting it.
