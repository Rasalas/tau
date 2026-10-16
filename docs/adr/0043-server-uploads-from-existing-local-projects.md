# ADR 0043: Upload selected files from the current local branch

Accepted, 2026-10-16. Revises the server entry flow, automatic drift checks and
connection lifetime described in ADR 0028. Its manual uploads, server backups,
conflict checks and machine-local storage remain in force.

A server project is normally an existing local folder. The primary action is to
select files and review an upload. Opening the project, starting a thread and
opening the server view read local state only. They neither require a first
download or Git initialization nor ask a server question. Upload proposals from
the agent are local selections and open the same review.

The mirror state remains a private Git store of verified contents. New targets
start with a partial state: a list of verified paths distinguishes known absences
from paths never read. Only a file inspection or the selected upload paths read
server contents. Every successful write advances its own path; failures retain
the previous state. The state belongs to the destination and folder mapping,
shared by branches and worktrees. Switching feature → main therefore computes
the selected reversal against what was uploaded, including explicit deletions of
known feature files. An upload preview binds confirmation to its branch, commit,
local bytes and observed server contents.

An explicit review click authorizes the displayed connection for this project on
this machine. A persisted fingerprint covers the destination, authentication
sources, SSH routing and transport security settings. Display names, ignore
patterns and concurrency do not revoke it. Host keys, certificates and credential
access retain their existing checks.

Before the first upload, one listing of the target folder checks the mapping's
plausibility. A weak match offers a deliberate continuation or a folder browser.
The browser reads one directory at a time; broader search requires its own action
and is bounded to two levels and 64 directories. Similar names establish neither
file equality nor which version is newer. Folder overrides live in Tau's state;
the project's sftp.json is unchanged. A destination or local-context change gets
a separate state directory, retaining the previous history when switching back.

Cancel and Stop remain available during network work. Cancelling also ends
pending questions. Completed upload files remain journalled after a stop. A
replacement of a local file keeps both versions reachable before the write, and
undo refuses to overwrite subsequent local work. Explicit legacy drift imports
and creating a new project by downloading a server remain advanced operations;
they are not prerequisites for uploads.
