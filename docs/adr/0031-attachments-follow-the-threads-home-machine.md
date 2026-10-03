# ADR 0031: Attachments follow the thread's home machine

The user expects an attachment to work when a draft runs on another machine. This supersedes ADR 0030's image-only restriction. Machines Kit and Remote Work Kit send files through the existing checksummed blob upload, and the receiving kit verifies the sending device before retaining a host-local copy. Sender paths never cross as file references. Images already carry their content.

The same rule applies to an existing checkout, a project taken along and a thread's later messages. Automatic must not silently choose this computer because the prompt has attachments. A missing agent connection or an older receiving kit rejects submission without discarding the draft. Runtimes without native file input receive the copied file's path in their prompt.
