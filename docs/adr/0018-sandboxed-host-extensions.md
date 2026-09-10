# ADR 0018: Sandboxed host extensions

## Status

**Proposal**, 2026-09-10. Not yet decided.

## Context

An isolated host extension runs in a `worker_threads` worker
(`src/main/host-extension-isolation.ts`). The worker provides:

- **Crash containment**: a throw, an exit, or an exceeded heap cap terminates
  the worker and deactivates the package; the main process keeps running.
- **Heap caps**: 256 MB old-space limit.
- **Timeout enforcement**: a command that does not resolve within 30 s
  deactivates the package.
- **A guardrail around network access**: without the `network` grant, `fetch`,
  `WebSocket`, `require("http")` and friends throw.

The worker does **not** provide a security boundary:

- The `Module._load` hook does not cover `import()` (dynamic import). A package
  can `await import("node:https")` and get a working module even without the
  `network` grant.
- A nested `worker_threads` worker runs outside the hook entirely.
- `child_process` is not blocked: the `process` grant gates the host's
  bookkeeping API (`noteSubprocess`, `findCommand`), not the spawn.
- `fs`, `vm`, `os`, `path`, `crypto` and all other Node builtins are reachable.

The grants are a statement of intent, not an enforcement mechanism. They tell
the user what the package *asks* for from the host; they do not stop a hostile
package from doing what it wants on the machine.

This ADR collects the options for closing that gap.

## Options

### Option 1: Child process with Node's permission model

Replace `worker_threads.Worker` with `child_process.fork` and pass:

```
--experimental-permission
--allow-fs-read=<package folder>
--allow-fs-write=<state directory>
```

Node 22's permission model is experimental but stable enough for Deno parity.
It denies filesystem, network and child-process access unless explicitly
granted. The host would map Tau's grants to Node's flags.

**Costs:**

- The port protocol (`host-extension-worker-protocol.ts`) must move from
  `MessagePort` to `process.send`/`process.on`. Serialization is the same; the
  wiring differs.
- Start/stop, heap caps, timeouts and failure paths all need reimplementing.
- Network enforcement under `--experimental-permission` is incomplete as of
  Node 22.23: `--allow-net` exists but may not cover every path. Needs
  verification.
- Fork startup is slower than worker startup (~50 ms vs. ~10 ms on macOS).

**What it buys:**

- A real boundary: `fs.readFile("/etc/passwd")` throws, not just
  `require("http")`.
- `await import()`, nested workers and `child_process` all hit the same wall.
- No userland hook can be bypassed because Node itself refuses.

### Option 2: `vm` realm with a curated `require`

Run the bundle inside `node:vm.createContext` with a handcrafted `require` that
only exposes allowed modules.

**Costs:**

- `vm` is explicitly **not** a security boundary. The Node documentation says
  so. An attacker with code execution in a `vm` context can escape.
- Maintaining a curated `require` means tracking every new builtin Node adds.
- Existing ecosystem code (`ws`, `undici`, `esbuild`) would need polyfills or
  would simply not work.

**What it buys:**

- Marginally cheaper than a process (same thread, no IPC).
- Disciplines well-behaved code.

This option is listed for completeness. It is not a security boundary and
should not be sold as one.

### Option 3: Keep the guardrails, drop the security narrative

The worker already provides crash containment, heap caps and timeout
enforcement. Those are valuable on their own: a hanging package does not freeze
the host, a package that allocates unboundedly does not OOM the app, and a
package that throws does not bring down the window.

Reframe `isolation: "worker"` as *robustness isolation*, not *security
isolation*. Update the documentation (done as of 2026-09-10) to:

- Describe the grants as a statement of intent.
- Describe the guardrails as guardrails, not boundaries.
- Explain that a package running in the worker cannot escape the heap cap or
  the timeout, but can reach the network and the filesystem if it tries hard
  enough.

**Costs:**

- A hostile package is not stopped.
- The manifest field `isolation` sounds like it does more than it does.

**What it buys:**

- No new code.
- Honest documentation.
- The existing value (crash containment) is preserved and correctly described.

## Recommendation

**Start with Option 3.** The documentation is now honest. The worker provides
real value — crash containment with a heap cap — and no longer claims a
boundary it cannot hold.

**Consider Option 1** if Tau will accept extension packages from untrusted
sources (a public registry, user-submitted packages). That decision is
separate: it requires moderation, signing, review, and a process around
updates, not just a sandbox. A sandbox without that process is incomplete; a
process without a sandbox can still be safe if the packages are from known
publishers.

**Avoid Option 2.** It is not a boundary and pretending it is one is worse
than the current state.

## Decision

Not yet made. This ADR is a proposal.

## Consequences (if Option 3 is ratified)

- No code change.
- The manifest field `isolation` stays as `"worker"` or `"in-process"`.
- `isolation: "worker"` means: crash containment, heap cap, timeout
  enforcement, and a guardrail around `require("http")`.
- The guardrail has documented gaps (`await import()`, nested workers).
- A package that wants to bypass the guardrail can, so the user should only
  install packages from publishers they trust.
