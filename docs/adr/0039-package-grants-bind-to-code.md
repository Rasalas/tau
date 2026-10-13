# ADR 0039: Package grants bind to code

Accepted, 2026-10-13. Updates ADR 0009 and chooses a scoped version of option 1
from ADR 0018 for installed host packages.

A grant covers the hash of every package file, including the manifest and
signature, plus the signer, permission set and isolation. A changed unsigned
or untrusted package needs consent again. An update signed by the same
still-trusted public key retains consent only with the same permissions and
isolation. Publisher names alone do not identify a trusted signer. Removing
the signature, replacing the trusted key or dropping its trust invalidates
consent. Legacy grants without a content hash require approval again.
The existing atomic JSON writer stores grants with mode 0600.

Installed packages declaring `worker` run in a child process with Node's
permission model. They can read their package and compiled entry and read and
write their own `services.stateDir`, prepared and checked by the host before activation. Other
files, including grants, the manifest, signature and other packages' data,
remain unwritable. `agentDir`, `sessionsDir` and `themesDir` are bootstrap paths
without direct file access. The host facade still checks grants. A trusted supervisor owns the package worker and
its heap, buffer and process memory caps; the worker inherits file restrictions
but cannot create another worker. RPC and timeout handling remain the same.
No host environment, runtime credentials or extra file descriptors are passed
in. Symbolic links in package files and the data folder, and permission
wildcards in process paths, are rejected. Bundled kits retain the existing
worker-thread transport and
file access because they ship as trusted code and use those files directly.

This is not an OS sandbox. Node's permission model does not promise safety
against arbitrary malicious code. Process or native permissions can bypass
file restrictions; network guards remain necessary on Node versions without
network permission flags. In-process and desktop code retain their existing
trust model. Settings and the native approval dialog explain these limits.
No extension API export or permission name is added.
