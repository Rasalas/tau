// The recipe `tau_new_package` writes into a new package as AGENTS.md: what an
// agent needs to build a Tau customization without reading Tau's source.
// Names here follow src/renderer/extension-system.tsx and docs/EXTENSIONS.md.

/** AGENTS.md for a new package; short on purpose, the API itself is in `.tau-types/`. */
export function agentsGuide({ id, name, apiVersion, host = true }) {
  const hostFile = host ? "- `host.ts`: the host half, a worker; the sample command `greet`.\n" : "";
  const hostSection = host
    ? "## Host half\n\nRuns in a worker; no window, no DOM. `import { HostCommandError, type WorkerHostExtension } from \"tau/host\"`; `context.registerCommand(\"name\", (input) => result, { access: \"read\" })`; the desktop half calls `context.host.invoke(\"name\", input)`. Bad input: throw `HostCommandError`.\n"
    : "## Host half\n\nNone. Only if the package must start programs or read files: add `host.ts` and `\"host\": \"./host.ts\"` to the manifest, with the permission it needs.\n";
  return `# ${name} (\`${id}\`)

A Tau package, for the extension API ${apiVersion}. It customizes Tau without touching Tau's own code, and it survives updates. Work only in this folder.

## Files

- \`tau-extension.json\`: manifest. Keep \`id\`; \`engines.api\` is \`^${apiVersion}\`. \`permissions\` is empty; add \`"process"\` (start programs) or \`"network"\` only when the host half needs it. A changed permission sends the package back to approval.
- \`desktop.tsx\`: the window half (React). The sample is a button${host ? " and a command" : ""}: replace it.
${hostFile}- \`styles.css\`: loaded while the package is on.
- \`.tau-types/\`: the real API. \`tau.d.ts\` (desktop) and \`host.d.ts\` (\`tau/host\`) lead to \`src/renderer/extension-system.d.ts\` (registrations, actions) and \`src/renderer/extension-api.d.ts\` (exports). Read them for anything not listed here; do not guess names.

## Desktop half

Import only from \`tau\`, \`react\`, \`lucide-react\`. \`activate(context)\` returns a disposer; registrations return theirs.

- Control: \`context.registerRegion({ id, placement, order?, Component })\`, \`Component\` gets \`{ actions, snapshot }\` (\`snapshot\`, may be undefined: \`sessionId\`, \`cwd\`, \`sessionTitle\`, \`model\`). Placements:
  \`title-bar\` end of the thread header (buttons) · \`thread-title\` before the title ·
  \`thread-details\` item in the header sub-line (draw a \`span.thread-detail\`) ·
  \`composer-above\` / \`composer-controls\` / \`composer-below\` · \`transcript-header\` / \`transcript-footer\` ·
  \`stage-bar\`. Status line: \`context.registerStatusItem({ id, align?, Component })\`.
- Palette command (⌘K): \`context.registerCommand({ id, label, group, access: "read" | "write", run(actions) {} })\`. \`"read"\` only looks or acts in the window; anything that changes the host is \`"write"\`. Chord: \`context.registerKeybinding({ keys: "mod+shift+k", commandId })\`.
- Actions: \`actions.copyText(text)\`, \`actions.notify(message, "info" | "warning" | "error")\`, \`actions.toast?.({ type, title, description })\`, \`actions.openExternal(url)\`.
- Thread branch: \`context.useService<ThreadBranchService>(THREAD_BRANCH_SERVICE, (branches) => context.registerRegion({ ..., Component: createButton(branches) }))\`. In the component: \`useSyncExternalStore(branches.subscribe, branches.current)?.branch\`. It gives \`{ cwd, branch?, upstream? }\`; never run \`git\` for this. Pull requests: \`THREAD_PULL_REQUESTS_SERVICE\`.
- Regions show on the desktop only; add \`profiles: ["desktop", "web", "compact"]\` for phones and the web client.

${hostSection}
## Look

- Colors only through Tau's variables, never a hex value: \`--ink\`, \`--ink-2\`, \`--muted\`, \`--line\`, \`--line-control\`, \`--sunken\`, \`--raised\`, \`--hover\`, \`--acid\` (accent).
- Reuse Tau's classes so controls match: header and bar buttons are \`<button className="chrome-button">\` with a 13 px lucide icon and an optional \`<span>\` label; also \`icon-button\`, \`text-button\`, \`chip\`.
- Tooltips: \`{...tooltipProps("Copy branch", { side: "bottom" })}\` from \`tau\`, not \`title\`.
- Keep a header button short or icon only; it shares a line with the title.

## Finish

1. Edit the files. Tau compiles on load, with no build step; a compile error shows as a toast with file and line.
2. Install: call \`tau_install_package\` with this folder. Without that tool, tell the user to type \`/install <this folder>\` in the composer.
3. Never approve the package yourself. The user allows it with one click ("Allow and turn on"); then it runs at once, and every save reloads it.
`;
}
