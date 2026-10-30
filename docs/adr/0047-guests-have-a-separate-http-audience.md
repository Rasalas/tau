---
status: accepted
---

# ADR 0047: Guests have a separate HTTP audience for one thread

A guest follows one thread through an expiring invitation that is claimed by one browser. Its invitation and browser credentials are separate hashed capabilities accepted only by the sharing extension's HTTP routes on listeners the owner already enabled. They never establish a workbench, paired-device, socket, RPC, MCP, terminal, file or tool principal. The extension authorizes a server-side allowlist projection before and after asynchronous reads. A guest's suggestions wait outside runtime admission until a person with Full access sends them through the existing queue; revocation removes both access and pending suggestions immediately.

Reusing Read-only pairing would expose every thread and workspace file, while a new general socket role would require narrowing every existing method and push. A dedicated audience preserves the Full and Read-only meanings in ADRs 0023, 0024 and 0037 and keeps optional sharing behavior in its extension. HTTP route registration and lifecycle hooks remain generic host machinery under ADRs 0002 and 0006. Successful durable revocation must be saved before reporting success; persistence failures are errors, never successful acknowledgements.
