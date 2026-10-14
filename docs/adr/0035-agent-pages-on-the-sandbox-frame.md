# ADR 0035: An agent shows its own HTML page through a kit, on the sandbox frame

ADR 0032 left agent-written pages for a kit once the frame existed. HTML Pages Kit (`kits/html-pages/`) is that kit. Core gained nothing for it: the frame, its route and its isolation are ADR 0032's, and the kit is a tool, a store and a card.

## The tool

`show_html_page({ title, html | path, origins?, height? })`, one tool for every runtime. Pi gets it as a runtime extension with `exposure: "deferred"` (the group is "pages" in `tool_search`, so a request without it stays small); every other runtime sees it as `mcp__tau__show_html_page` through `services.mcp.registerTools`, and the endpoint's instructions carry one paragraph on when to use it. The thread comes from the registering side (the Pi session or the MCP credential), never from the call.

- **`html` or `path`, not both.** A path is read from the project or the temp folder after `realpath`, so a link out of them is refused. A page over 1 MiB is refused with a hint to write a file.
- **Local images** named in `src` or `url()` (absolute or relative to the file) are embedded as data URLs when the tool runs, from the same two folders, 3 MiB each and 4 MiB together. The page then survives the files and needs no file access. What cannot be embedded stays as written and the tool result says so.
- **`origins`** are the only way a page reaches the network. Each must be an https host name (no address, `localhost`, local-network suffix, wildcard or credentials; at most 8) and becomes a `resourceDomains` entry of the frame's policy. `connect-src`, frames and `base-uri` stay empty, so `fetch`, XHR and WebSocket are always blocked. A policy cannot tell a private address from a public one, which is why names are checked at declaration, not at request time: a public name that resolves to a private address (DNS rebinding) is not caught, and the card shows the declared hosts so the reader can see them.
- **The result** is one line ending in `[tau-html-page:<id>]`. A card reads the id back from the transcript, so it needs no `extras` and works for every runtime that reports the tool's output.

## Storage and life

A page is `<id>.html` plus `<id>.json` under the kit's state folder, one folder per thread, the JSON written last. A thread keeps 40 pages and 50 MiB, the oldest first. `threadDeleted` removes the folder (the trash keeps pages for its 30 days); a restart changes nothing. The host never publishes a frame until a client asks.

## The card

A tool card matches the tool by name (with or without the `mcp__tau__` prefix) and, once the call settled, asks the kit's host half to `open` the page. The host adds Tau's theme variables, a base style, a height reporter and a link forwarder to the document, and `publishFrame`s it with the page's origins. The card sets the height from `ui/notifications/size-changed` (up to the agent's `height`, 720 px by default) and opens a clicked http(s) link, which the page forwards as `ui/open-link` with the ⌘ and Ctrl state of the click, only while the frame has focus and the click is live. The link goes where a link in a reply goes: Preview Kit's `tau.preview/links` service decides by Settings → Preview, and ⌘ or Ctrl-click or a missing Preview Kit means the system browser. Full screen is `SandboxFrame`'s, so the page keeps its state. "Open in a tab" mounts the page in a stage tab with a fresh frame (the iframe cannot move between parents without reloading), so the page restarts there.

- **Theme.** The card sends the values of a fixed list of Tau tokens as declared (`light-dark(…)` included), so a page follows light and dark live through the colour scheme the frame already sets. The page sees `--background`, `--foreground`, `--accent`, `--border`, `--chart-1…6` and so on, named as in T3 Code so a model's habits carry over. A custom theme's values are read when the page opens and not updated while it is open.
- **Phone and web** get the page through `host.resourceUrl`, like every frame. The stage tab is for desktop and web profiles.

## Not decided here

- Preview of a page for the agent (a screenshot and console output before it publishes, T3's `html_preview`). Tau's Preview and Computer Use already let an agent look at a page it serves.
- A page's own stored state, or calls from a page back to its thread (the MCP Apps requests Codex's bridge answers). A page here is output.
- Listing a thread's pages outside the transcript.
