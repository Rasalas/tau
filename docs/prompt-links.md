# Prepared prompts from links

A prompt link opens Tau with text in a new thread's draft. Read and edit the
text, then press Send. Opening the link never sends a message or runs a command.
Desktop and phone use the same draft placement.

```text
tau://new?prompt=Explain%20the%20test%20failure
tau://new?host=machine-id&project=workspace-id&prompt=Check%20the%20build&provider=provider-id&model=model-id
```

Encode values with `URLSearchParams` or `encodeURIComponent`.

| Parameter | Meaning |
| --- | --- |
| `prompt` | Required text. Tau keeps at most 8,000 UTF-16 code units and shows a warning when it shortens the text. |
| `host` | Optional machine ID. The desktop uses a connected saved machine; the phone uses an already paired machine. Without it, the current machine or the phone's last used machine opens. A link never pairs a machine. |
| `project` | Optional workspace ID, exact project path, or unique project name from that machine's known projects. A link never clones or opens an unknown path. |
| `model` | Optional model ID from the draft runtime's catalog. |
| `provider` | Optional provider ID to distinguish models with the same ID. |

A known project opens directly. Otherwise Tau keeps the current project, or
uses the first known project, and reports unknown project context. With no
projects, add one and open the link again. The runtime and permissions keep
the user's defaults. A model that is unavailable or ambiguous leaves the draft's
model unchanged and produces a notice.

If the draft in that project already contains text, Tau asks before replacing
it. Cancel keeps the existing text. Moving from a thread or another project's
draft opens a fresh draft and preserves the previous draft through normal
navigation. A link does not fill an existing thread's composer.

The text is untrusted. URL parameters cannot submit, attach files, run shell
commands, select permissions or execute slash commands. A leading `/` stays
text until the user submits it. Unknown parameters, including `send`, are
ignored. Existing thread links (`tau://thread?thread=…`) keep their meaning.
On a phone the prompt parameters leave the address after they are consumed.

Installed desktop builds register the `tau` URL scheme. Development checkouts
do not change the operating system's URL handlers.
