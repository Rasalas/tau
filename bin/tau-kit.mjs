// `tau kit new <name>`: a package folder to start from, with both halves, a
// command, a stylesheet, a README and the extension API's types for the editor.
// `tau kit types [folder]` copies the types in again after Tau was updated.
// Plain Node, no dependencies: the types come from the app (a release ships
// them as `extension-api/` beside its archive) or a built checkout.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KIT_USAGE = `Usage: tau kit new <name or path> [--id <id>] [--name <name>] [--no-host] [--install [--local]]
       tau kit types [folder]

tau kit new writes a package folder to start a kit of your own from: its
manifest (tau-extension.json), a desktop half with a button and a command, a
host half with one command, a stylesheet, a README, a tsconfig.json and the
types of Tau's extension API in .tau-types/, so an editor checks it without an
npm install. The folder is <name> in the current directory, or the path you
give; its id is local.<name> unless --id names one. Settings shows it as
--name, or as the folder name in title case with acronyms kept (pr-title:
"PR Title"). --no-host leaves the host half out. --install asks the running Tau to install the folder for every
project (--local: for the project on screen); approve it in Settings →
Extensions, then edit and save.

tau kit types copies this Tau's extension API types into a package folder
(the current directory by default) as .tau-types/, and writes a tsconfig.json
that uses them if the folder has none. Run from a Tau checkout, both commands
build the types from its source first.`;

/** A manifest id: lowercase words, dots between vendor and name. */
const EXTENSION_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
export const TYPES_FOLDER = ".tau-types";

export function parseKitArgs(rest) {
  const [action, ...args] = rest.filter((arg) => arg !== "--");
  if (!action || action === "-h" || action === "--help" || args.includes("-h") || args.includes("--help")) return { help: true };
  if (action === "types") {
    if (args.length > 1) throw new Error("tau kit types takes one folder.");
    return { action, folder: args[0] };
  }
  if (action !== "new") throw new Error(`Unknown kit action "${action}". ${KIT_USAGE}`);
  const options = { action, host: true, install: false, local: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-host") options.host = false;
    else if (arg === "--install") options.install = true;
    else if (arg === "--local" || arg === "-l") options.local = true;
    else if (arg === "--id" || arg === "--name") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
      options[arg.slice(2)] = value;
      index += 1;
    } else if (arg.startsWith("-")) throw new Error(`tau kit new does not know ${arg}.`);
    else if (options.target) throw new Error("tau kit new takes one name.");
    else options.target = arg;
  }
  if (!options.target) throw new Error("Name the kit: tau kit new <name>.");
  if (options.local && !options.install) throw new Error("--local goes with --install.");
  return options;
}

/** `pr-title` from "PR title", `my-kit` from "My Kit". */
export function kitSlug(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").replace(/^[^a-z]+/u, "");
  if (!slug) throw new Error(`"${name}" gives no usable kit name; use letters, digits and dashes.`);
  return slug;
}

/** Words a title keeps in capitals. */
const ACRONYMS = new Set(["ai", "api", "ci", "cli", "css", "db", "html", "http", "id", "json", "llm", "mcp", "pr", "sql", "ssh", "ui", "url", "ux", "xml", "yaml"]);

/** "PR Title" from `pr-title`: what Settings shows until the author names it. */
export function kitTitle(slug) {
  return slug.split("-").filter(Boolean)
    .map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

/** The display name: `--name`, a folder named like a title ("PR title"), or the slug in title case. */
export function kitName(folderName, slug, name) {
  if (name?.trim()) return name.trim();
  return folderName === slug ? kitTitle(slug) : folderName.trim();
}

/** The `paths` a package's tsconfig.json maps onto the copied types; `vendor/` is scripts/build-types.mjs's layout. */
export function typePaths(folder = `./${TYPES_FOLDER}`) {
  return {
    tau: [`${folder}/tau.d.ts`],
    "tau/host": [`${folder}/host.d.ts`],
    "tau/host-extension": [`${folder}/host-extension.d.ts`],
    react: [`${folder}/vendor/react`],
    "react/*": [`${folder}/vendor/react/*`],
    csstype: [`${folder}/vendor/csstype`],
    "lucide-react": [`${folder}/vendor/lucide-react/dist/lucide-react.d.ts`],
    "undici-types": [`${folder}/vendor/undici-types`],
  };
}

export function kitTsconfig() {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      module: "ESNext",
      moduleResolution: "Bundler",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      typeRoots: [`./${TYPES_FOLDER}/vendor/@types`],
      types: ["node"],
      paths: typePaths(),
    },
    include: ["*.ts", "*.tsx"],
  }, null, 2)}\n`;
}

/** Every file of a new kit, by name. Pure, so the scaffold is tested without a disk. */
export function kitFiles({ id, name, apiVersion, host = true }) {
  const css = id.split(".").pop();
  const manifest = {
    id,
    name,
    description: `What ${name} does, in one sentence.`,
    version: "0.1.0",
    engines: { api: `^${apiVersion}` },
    permissions: [],
    desktop: "./desktop.tsx",
    ...(host ? { host: "./host.ts" } : {}),
    styles: "./styles.css",
  };
  const files = {
    "tau-extension.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "desktop.tsx": host ? desktopWithHost(id, name, css) : desktopOnly(id, name, css),
    "styles.css": `/* ${name}'s own rules; Tau's tokens (var(--ink), var(--line)…) keep it in the theme. */
.${css}-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border: 1px solid var(--line-control);
  border-radius: 6px;
  background: none;
  color: var(--ink-2);
  font: 12px var(--sans);
  cursor: pointer;
}
.${css}-button:hover:not(:disabled) { color: var(--ink); background: var(--sunken); }
.${css}-button:disabled { opacity: .5; cursor: default; }
`,
    "tsconfig.json": kitTsconfig(),
    ".gitignore": `${TYPES_FOLDER}/\nnode_modules/\n`,
    "README.md": readme({ id, name, host }),
  };
  if (host) files["host.ts"] = hostHalf(id, name);
  return files;
}

function desktopWithHost(id, name, css) {
  return `import { Sparkles } from "lucide-react";
import { hostAvailability, useHostAvailability, type DesktopExtension, type HostExtensionClient, type RegionProps, type WorkbenchActions } from "tau";

const ID = ${JSON.stringify(id)};

/** Asks the host half for a greeting and shows it; an error is a toast too. */
async function greet(host: HostExtensionClient, actions: WorkbenchActions): Promise<void> {
  try {
    const answer = await host.invoke("greet", { name: "you" }) as { message: string };
    actions.toast?.({ type: "success", title: ${JSON.stringify(name)}, description: answer.message });
  } catch (error) {
    actions.toast?.({ type: "error", title: ${JSON.stringify(name)}, description: error instanceof Error ? error.message : String(error) });
  }
}

function createButton(host: HostExtensionClient) {
  return function GreetButton({ actions }: RegionProps) {
    // Off, with the reason as its tooltip, while the host half does not run.
    const { available, reason } = useHostAvailability(ID);
    return (
      <button type="button" className="${css}-button" disabled={!available} title={reason ?? "Ask the host half for a greeting"} onClick={() => void greet(host, actions)}>
        <Sparkles size={12} /> ${name}
      </button>
    );
  };
}

const extension: DesktopExtension = {
  id: ID,
  name: ${JSON.stringify(name)},
  activate(context) {
    // A button at the end of the thread header, and the same action in the command palette (⌘K).
    const button = context.registerRegion({ id: \`\${ID}.button\`, placement: "title-bar", Component: createButton(context.host) });
    const command = context.registerCommand({
      id: \`\${ID}.greet\`,
      label: ${JSON.stringify(`${name}: say hello`)},
      group: ${JSON.stringify(name)},
      access: "read",
      unavailable: () => hostAvailability(ID).reason,
      run: (actions) => greet(context.host, actions),
    });
    return () => { button(); command(); };
  },
};

export default extension;
`;
}

function desktopOnly(id, name, css) {
  return `import { Sparkles } from "lucide-react";
import type { DesktopExtension, RegionProps } from "tau";

const ID = ${JSON.stringify(id)};

function HelloButton({ actions }: RegionProps) {
  return (
    <button type="button" className="${css}-button" onClick={() => actions.toast?.({ type: "success", title: ${JSON.stringify(name)}, description: "Hello from the desktop half." })}>
      <Sparkles size={12} /> ${name}
    </button>
  );
}

const extension: DesktopExtension = {
  id: ID,
  name: ${JSON.stringify(name)},
  activate(context) {
    // A button at the end of the thread header.
    return context.registerRegion({ id: \`\${ID}.button\`, placement: "title-bar", Component: HelloButton });
  },
};

export default extension;
`;
}

function hostHalf(id, name) {
  return `import { HostCommandError, type WorkerHostExtension } from "tau/host";

/**
 * The host half runs in a worker of its own, away from the window. It asks
 * for no permissions; add one to "permissions" in tau-extension.json when it
 * needs it ("process" to start programs, "network" to reach the network), and
 * approve the package again.
 */
const extension: WorkerHostExtension = {
  id: ${JSON.stringify(id)},
  name: ${JSON.stringify(name)},
  activate(context) {
    context.registerCommand("greet", (input) => {
      const who = (input as { name?: unknown } | undefined)?.name ?? "there";
      // Bad input is the caller's mistake: a HostCommandError never counts toward switching the package off.
      if (typeof who !== "string") throw new HostCommandError('"name" must be text.');
      return { message: \`Hello \${who}, from the host half of ${name}.\` };
    }, { access: "read" });
  },
};

export default extension;
`;
}

function readme({ id, name, host }) {
  return `# ${name}

A Tau package (\`${id}\`), made with \`tau kit new\`.

| File | What it is |
|---|---|
| \`tau-extension.json\` | The manifest: id, name, the extension API it needs, permissions, entries |
| \`desktop.tsx\` | The desktop half: a button in the thread header and a command in the palette |
${host ? "| `host.ts` | The host half, in a worker: the `greet` command the desktop half calls |\n" : ""}| \`styles.css\` | Its own rules, loaded while it is on |
| \`tsconfig.json\`, \`.tau-types/\` | Types for your editor; Tau compiles the package itself |

## Use it

1. In Tau, type \`/install <this folder>\` in the composer (every project), or
   \`/install <this folder> -l\` for the project on screen. \`tau kit new --install\` does the same.
2. Approve it: Settings → Extensions → ${name} → **Allow and turn on**.
3. Edit and save. Tau rebuilds it on every save; a save that does not compile
   keeps the running version and shows the error with its line in a toast and
   in Settings → Packages → Develop a package.

Changing \`permissions\` sends it back to step 2. After updating Tau, run
\`tau kit types\` here for the new types.

## Check it

Your editor reads \`tsconfig.json\`. From a terminal: \`npx -p typescript tsc -p .\`.

The reference is \`docs/EXTENSIONS.md\` in Tau's repository.
`;
}

/**
 * Where this Tau's extension API types are: \`TAU_TYPES_DIR\`, the resource a
 * release ships beside its archive, or a checkout's \`dist-types/\`, built
 * from its source each time so an edit to the API is in the copy.
 */
export function extensionApiTypes({ env = process.env, self = fileURLToPath(import.meta.url), build = buildCheckoutTypes, warn = () => undefined } = {}) {
  if (env.TAU_TYPES_DIR) return resolve(env.TAU_TYPES_DIR);
  const root = dirname(dirname(realpathSync(self)));
  if (basename(root) === "app.asar.unpacked") {
    const shipped = join(dirname(root), "extension-api");
    return existsSync(join(shipped, "package.json")) ? shipped : undefined;
  }
  const built = join(root, "dist-types", "extension-api");
  if (existsSync(join(root, "scripts", "build-types.mjs"))) {
    const failure = build(root);
    if (failure && existsSync(join(built, "package.json"))) {
      warn(`Could not build the extension API types from this checkout (${failure}); copying the last build, from ${statSync(join(built, "package.json")).mtime.toLocaleString()}, which may be older than the source.`);
    }
  }
  return existsSync(join(built, "package.json")) ? built : undefined;
}

/** Builds a checkout's types; the reason it failed, or nothing. */
function buildCheckoutTypes(root) {
  const result = spawnSync(process.execPath, [join(root, "scripts", "build-types.mjs")], { cwd: root, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (result.error) return result.error.message;
  return result.status === 0 ? undefined : (result.stderr.trim().split("\n").at(-1) || `exit code ${result.status}`);
}

function requireTypes(options) {
  const types = extensionApiTypes(options);
  if (!types) throw new Error("This copy of the command line cannot find Tau's extension types. Run it from an installed Tau or a built checkout (npm run build).");
  return types;
}

/** Copies the types into `<folder>/.tau-types`, replacing an older copy. */
export function copyTypes(types, folder) {
  const target = join(folder, TYPES_FOLDER);
  rmSync(target, { recursive: true, force: true });
  cpSync(types, target, { recursive: true });
  return JSON.parse(readFileSync(join(types, "package.json"), "utf8")).version;
}

export async function runKit(options, io = {}) {
  const out = io.out ?? ((line) => process.stdout.write(`${line}\n`));
  const cwd = io.cwd ?? process.cwd();
  if (options.help) { out(KIT_USAGE); return 0; }
  const types = requireTypes({ warn: out, ...io.types });
  if (options.action === "types") {
    const folder = resolve(cwd, options.folder ?? ".");
    if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`${folder} is not a folder.`);
    const version = copyTypes(types, folder);
    const tsconfig = join(folder, "tsconfig.json");
    const wrote = !existsSync(tsconfig);
    if (wrote) writeFileSync(tsconfig, kitTsconfig());
    out(`Copied the extension API ${version} types into ${join(folder, TYPES_FOLDER)}.${wrote ? " Wrote tsconfig.json to use them." : " Kept the tsconfig.json that was there; the one tau kit new writes maps tau, tau/host, tau/host-extension, react and lucide-react onto them."}`);
    return 0;
  }
  const folder = resolve(cwd, options.target);
  if (existsSync(folder) && (!statSync(folder).isDirectory() || readdirSync(folder).length > 0)) throw new Error(`${folder} exists and is not empty.`);
  const slug = kitSlug(basename(folder));
  const id = options.id ?? `local.${slug}`;
  if (!EXTENSION_ID.test(id)) throw new Error(`"${id}" is not a package id: lowercase letters, digits and dashes, words joined by dots.`);
  const apiVersion = JSON.parse(readFileSync(join(types, "package.json"), "utf8")).version;
  const name = kitName(basename(folder), slug, options.name);
  mkdirSync(folder, { recursive: true });
  const files = kitFiles({ id, name, apiVersion, host: options.host });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(folder, file), text);
  copyTypes(types, folder);
  out(`Created ${folder}: ${name} (${id}), for the extension API ${apiVersion}.`);
  if (options.install) {
    const answer = await io.install?.(folder, options.local ? "project" : "global");
    out(answer?.message ?? `Installed ${folder}.`);
    out(answer?.untrusted
      ? `Next: in Tau, Settings → Packages → Trust this project; then approve ${name} in Settings → Extensions, and edit and save.`
      : `Next: approve it in Tau's Settings → Extensions → ${name}, then edit and save.`);
  } else {
    out(`Next: in Tau, type /install ${folder} in the composer, approve it in Settings → Extensions, then edit and save.`);
  }
  return 0;
}
